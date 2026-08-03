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

use syntax::{lex::lex, parse::parse};

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

/// How far the compiler currently goes. Today: text to tree. The checker
/// and the backend join here as they land, and every existing .lang file
/// starts exercising them without being touched.
fn compile(source: &str) -> Result<(), String> {
    let tokens = lex(source).map_err(|error| error.message)?;
    parse(&tokens).map_err(|error| error.message)?;
    Ok(())
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

        match (expected_message(&source), compile(&source)) {
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
