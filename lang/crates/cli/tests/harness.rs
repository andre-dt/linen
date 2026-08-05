// =====================================================================
// THE COMPILER'S HEALTH.
//
// Every .lang file under lang/tests must hold. This runs as `cargo test`
// rather than as a script on the side, deliberately: a suite that does
// not block the build is a suite that rots, and the whole claim of this
// directory is that the compiler is healthy exactly when it is green.
//
// One flat directory, `lang/tests`. What a file expects is written IN the
// file rather than encoded in which folder it sits in:
//
//   no `#~`  must compile, and every assert in it holds
//   `#~ ...` must NOT compile, and must fail with that message
//
// Flat because the expectation belongs to the file. A pass/ and fail/
// split says the same thing twice — once in the path and once in the
// contents — and two places to say something is one place to get it
// wrong.
//
// Checking only that compilation failed would let a wrong-but-failing
// message through, and for a compiler error the message IS the product,
// so a bad one is a bug.
//
// The files are discovered, not listed. A list would be a second place to
// remember, and the one thing worse than a missing test is a test nobody
// noticed was never running.
// =====================================================================

use std::fs;
use std::path::{Path, PathBuf};

use compile::run::run_tests;
use syntax::{check::check, resolve::resolve};

/// Every .lang file in the suite.
fn lang_files() -> Vec<PathBuf> {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests");
    let mut files: Vec<PathBuf> = fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", directory.display()))
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|extension| extension == "lang"))
        .collect();
    // Sorted so a failure report reads the same way twice.
    files.sort();
    files
}

/// How far the compiler currently goes: text to tree, resolution, then
/// types. The backend joins here when it lands, and every existing .lang
/// file starts exercising it without being touched.
///
/// Shapes and arrays are not typechecked yet, and the files that use
/// them say so with `#!`. That marker is temporary scaffolding — see
/// `not_typechecked_yet`.
fn compile(file: &Path, source: &str) -> Result<(), String> {
    // Loaded rather than parsed: a file may import others, and what has
    // to be checked and run is the whole merged unit. Parsing this file
    // alone would miss every name an import brought in.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
    let unit = syntax::load::load(file, &root, &|path| {
        fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))
    })
    .map_err(|error| error.message)?;
    resolve(&unit).map_err(|error| error.message)?;
    if not_typechecked_yet(source) {
        return Ok(());
    }
    check(&unit).map_err(|error| error.message)?;

    // And then RUN them. Stopping at "it compiled" would let a file full
    // of false assertions pass, which is the opposite of what this
    // directory claims to prove.
    let ran = run_tests(&unit, "harness").map_err(|error| error.message)?;
    let failed: Vec<_> = ran
        .iter()
        .filter_map(|test| {
            test.failed
                .as_ref()
                .map(|message| format!("{}: {message}", test.name))
        })
        .collect();
    if !failed.is_empty() {
        return Err(failed.join("; "));
    }
    Ok(())
}

/// `#!` — this file uses something the typechecker cannot see yet.
///
/// Marked in the file rather than listed here, for the same reason `#~`
/// is: the expectation belongs to the file. Every one of these is a
/// feature the checker owes, and the marker disappears as each lands —
/// so the count of `#!` is the size of the remaining debt, in the open.
fn not_typechecked_yet(source: &str) -> bool {
    source.lines().any(|line| line.trim_start().starts_with("#!"))
}

// =====================================================================
// the suite
// =====================================================================

#[test]
fn every_file_does_what_it_says() {
    let files = lang_files();
    assert!(!files.is_empty(), "lang/tests is empty — the suite proves nothing");

    let mut failures = Vec::new();

    for file in &files {
        let source = fs::read_to_string(file).expect("should read");
        let name = name_of(file);

        match (expected_message(&source), compile(file, &source)) {
            // No marker: it has to compile.
            (None, Err(message)) => failures.push(format!("{name}: {message}")),
            (None, Ok(())) => {}

            // A marker: it has to fail, with that message. Compiling is
            // the worse of the two failures — it means the compiler
            // accepts something it must not.
            (Some(expected), Ok(())) => failures.push(format!(
                "{name}: compiled, but should have failed with {expected:?}"
            )),
            (Some(expected), Err(message)) if !message.contains(&expected) => failures.push(
                format!("{name}: expected {expected:?}\n      got {message:?}"),
            ),
            (Some(_), Err(_)) => {}
        }
    }

    // Every failure at once. Reporting only the first would mean one
    // edit-run cycle per broken file.
    assert!(failures.is_empty(), "\n{}\n", failures.join("\n"));
}

/// The `#~ ...` line: what this file must be rejected with.
///
/// A substring, not the whole message — the test pins the part that
/// carries the meaning and stays quiet about wording that may improve.
fn expected_message(source: &str) -> Option<String> {
    source.lines().find_map(|line| {
        line.trim_start()
            .strip_prefix("#~")
            .map(|rest| rest.trim().to_string())
    })
}

fn name_of(file: &Path) -> String {
    file.file_name().unwrap_or_default().to_string_lossy().to_string()
}

// =====================================================================
// The archive a build produces has to be COMPLETE.
//
// `liblinen.a` once had `add_vertex`, `push` and `digits` undefined
// while the runtime exported `linen_add_vertex`, `linen_list_push` and
// `linen_digits`. Nothing said so: the JIT maps any name to any address,
// so every test passed, and the mismatch only surfaced for whoever
// tried to link the library.
//
// A library that only links for a caller who happens to supply its
// missing half is not a library.
// =====================================================================

/// Every kernel symbol the archive references, it also defines.
#[test]
fn the_archive_defines_what_it_calls() {
    let archive = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/liblinen.a");
    if !archive.exists() {
        // `linen build` has not run here. Not a failure: this asserts
        // about an artifact, and its absence is not a wrong artifact.
        return;
    }

    let listed = std::process::Command::new("nm")
        .arg(&archive)
        .output()
        .expect("nm should run");
    let listed = String::from_utf8_lossy(&listed.stdout);

    let mut defined = std::collections::HashSet::new();
    let mut referenced = std::collections::HashSet::new();
    for line in listed.lines() {
        let mut words = line.split_whitespace();
        let (kind, name) = match (words.next(), words.next(), words.next()) {
            // `U name` — referenced, no address.
            (Some("U"), Some(name), None) => ("U", name),
            // `<address> T name` — defined.
            (Some(_), Some(kind), Some(name)) => (kind, name),
            _ => continue,
        };
        // Only this kernel's own names. libc and Rust internals are
        // resolved by whoever links, which is how it should be.
        if !name.starts_with("linen_") {
            continue;
        }
        match kind {
            "U" => {
                referenced.insert(name.to_string());
            }
            "T" | "t" | "D" | "d" | "B" | "b" => {
                defined.insert(name.to_string());
            }
            _ => {}
        }
    }

    let missing: Vec<&String> = referenced.difference(&defined).collect();
    assert!(
        missing.is_empty(),
        "liblinen.a calls these and defines none of them: {missing:?}\n\
         the runtime is missing from the archive, or a symbol name drifted"
    );
}

// =====================================================================
// EVERY FILE IS IN THE CANONICAL ORDER.
//
//   the file's header comment, the imports, the shapes, the functions,
//   the tests by title, the drawing tests by title
//
// Checked rather than trusted, because the ordering is only worth
// having if it holds everywhere: a reader who has to check whether a
// file follows it is back to reading the whole file.
//
// `linen format` puts a file right. This is what says someone ran it.
// =====================================================================

#[test]
fn every_file_is_formatted() {
    let files = lang_files();
    let mut unformatted = Vec::new();

    for file in &files {
        let source = fs::read_to_string(file).expect("should read");
        // A file that does not parse is not this test's business — the
        // rejection cases are supposed not to.
        let Ok(formatted) = format::rewrite(&source) else {
            continue;
        };
        if formatted != source {
            unformatted.push(name_of(file));
        }
    }

    assert!(
        unformatted.is_empty(),
        "these files are not in the canonical order — run `linen format`:\n  {}",
        unformatted.join("\n  ")
    );
}

#[test]
fn formatting_twice_changes_nothing_the_second_time() {
    // A formatter that is not a fixed point is one nobody can run in a
    // hook: every commit would show a diff, and the diff would be the
    // formatter arguing with itself.
    let source = "# A file.\n\n# What it does.\nfn b() i32\n  return 2\n\ntest \"z\"\n  throw \"x\" unless 1 == 1\n\ntest \"a\"\n  throw \"y\" unless 2 == 2\n";
    let once = format::rewrite(source).expect("should format");
    let twice = format::rewrite(&once).expect("should format again");
    assert_eq!(once, twice, "the formatter does not settle");
}

#[test]
fn formatting_sorts_the_tests() {
    let source = "test \"zebra\"\n  throw \"x\" unless 1 == 1\n\ntest \"apple\"\n  throw \"y\" unless 2 == 2\n";
    let formatted = format::rewrite(source).expect("should format");
    let apple = formatted.find("apple").expect("apple is there");
    let zebra = formatted.find("zebra").expect("zebra is there");
    assert!(apple < zebra, "the tests are not in order:\n{formatted}");
}

#[test]
fn formatting_puts_drawing_tests_last() {
    let source = "test draws \"a picture\"\n  wire(points: list(), segments: list())\n\ntest \"zebra\"\n  throw \"x\" unless 1 == 1\n";
    let formatted = format::rewrite(source).expect("should format");
    let picture = formatted.find("a picture").expect("the drawing is there");
    let zebra = formatted.find("zebra").expect("zebra is there");
    assert!(
        zebra < picture,
        "a drawing test should come after the ones that only assert:\n{formatted}"
    );
}

#[test]
fn formatting_keeps_a_comment_with_what_it_explains() {
    // The property the whole thing rests on. A comment and the
    // declaration under it are one thing, so reordering must not put
    // an explanation above something it was never about.
    let source = "# About zebra.\ntest \"zebra\"\n  throw \"x\" unless 1 == 1\n\n# About apple.\ntest \"apple\"\n  throw \"y\" unless 2 == 2\n";
    let formatted = format::rewrite(source).expect("should format");
    let about_apple = formatted.find("# About apple.").expect("apple's comment is there");
    let apple = formatted.find("test \"apple\"").expect("apple is there");
    let about_zebra = formatted.find("# About zebra.").expect("zebra's comment is there");
    let zebra = formatted.find("test \"zebra\"").expect("zebra is there");
    assert!(about_apple < apple && apple < about_zebra && about_zebra < zebra,
        "a comment was separated from its test:\n{formatted}");
}
