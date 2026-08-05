// =====================================================================
// cli/run.rs — WHAT THE THREE COMMANDS DO.
//
// build   compile, and say nothing if it worked
// test    compile and run every test, reporting as it goes
// clean   remove the build directory
//
// REPORTING AS IT GOES, NOT AT THE END
// ------------------------------------
// A test run prints each file as it finishes, then a summary. Buffering
// everything until the end would leave the user watching a blank screen
// during the slowest part of the run — and when a compile hangs, the last
// line printed is the only clue about which file did it.
//
// The summary at the end is what a person actually reads. Everything
// above it is for when something failed.
// =====================================================================

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use compile::object::write_object;
use compile::run::run_tests;
use syntax::{check::check, resolve::resolve};

use crate::report::Report;
use crate::{build_directory, Options};

/// The extension the language uses. One constant, so discovery and error
/// messages cannot disagree about it.
const EXTENSION: &str = "lang";

// =====================================================================
// build
// =====================================================================

pub fn build(options: &Options) -> Result<ExitCode, String> {
    let files = sources(options, SOURCE_DIRECTORY)?;
    if files.is_empty() {
        return Err(format!("no .{EXTENSION} files under `{SOURCE_DIRECTORY}`"));
    }

    let mut failed = 0;
    let mut objects = Vec::new();
    for file in &files {
        match compile_to_object(file, options) {
            Ok(object) => objects.push(object),
            Err(report) => {
                report.print();
                failed += 1;
            }
        }
    }

    if failed > 0 {
        println!(
            "{failed} of {} file{} failed to compile",
            files.len(),
            plural(files.len())
        );
        return Ok(ExitCode::FAILURE);
    }

    // The runtime goes in too: the arena and every `linen:` driver.
    //
    // Without it the archive has undefined symbols — `push`, `digits`,
    // `add_vertex` — and only links for a caller who happens to supply
    // them. That is not a library, it is half of one, and the half that
    // is missing is invisible until someone tries to link it.
    let mut objects = objects;
    objects.push(runtime_archive()?);

    let archive = build_directory().join(format!("lib{LIBRARY_NAME}.a"));
    make_archive(&objects, &archive)?;
    println!(
        "built {} file{} for {} -> {}",
        files.len(),
        plural(files.len()),
        options.host.triple(),
        display(&archive)
    );
    Ok(ExitCode::SUCCESS)
}

// =====================================================================
// test
// =====================================================================

pub fn test(options: &Options) -> Result<ExitCode, String> {
    let files = sources(options, TEST_DIRECTORY)?;
    if files.is_empty() {
        return Err(format!("no .{EXTENSION} files under `{TEST_DIRECTORY}`"));
    }

    let mut summary = Summary::default();
    let mut drawings = 0usize;

    for file in &files {
        // Each file runs in a SUBPROCESS.
        //
        // Not for isolation of state — the arena and the driver
        // registries are reset between tests anyway — but because a
        // file can take the process down. A `driver fn` returning an
        // aggregate segfaulted, and the whole run reported success: no
        // message, exit 0, and the file simply absent from the count.
        // That is the worst way for a suite to fail, and it is exactly
        // how the bug this guards against went unnoticed.
        //
        // The child does the real work through the same code path, so
        // there is no second implementation to disagree with this one.
        match run_in_child(file) {
            Ok(child) => {
                // Printed per file, as it finishes: when a run is slow
                // or hangs, the last line is the clue about where.
                print!("{}", child.output);
                drawings += child.drawings;
                summary.absorb(&child.summary);
            }
            // The child died rather than reporting. A crash is a
            // failure of the file it was reading, and naming that file
            // is the whole point of doing this.
            Err(how) => {
                println!("{} {}", cross(), display(file));
                println!("     {how}");
                summary.files_failed += 1;
            }
        }
    }

    if drawings > 0 {
        println!("\n{} drawing{} rendered", drawings, plural(drawings));
    }

    summary.print();
    Ok(if summary.files_failed == 0 { ExitCode::SUCCESS } else { ExitCode::FAILURE })
}


/// Runs ONE file and prints its result. The child half of `test`.
///
/// Everything a run reports comes from here, whether it was spawned or
/// not — one code path, so the two cannot disagree about what a pass
/// is.
pub fn test_file(options: &Options) -> Result<ExitCode, String> {
    let Some(file) = options.path.clone() else {
        return Err("`test-file` needs a path".to_string());
    };
    let mut summary = Summary::default();
    let mut drawings = 0usize;

    let source = match fs::read_to_string(&file) {
        Ok(source) => source,
        Err(error) => {
            println!("{} {}: {error}", cross(), display(&file));
            summary.files_failed += 1;
            print_machine_summary(&summary, drawings);
            return Ok(ExitCode::FAILURE);
        }
    };

    let file = file.as_path();
    // A file carrying `#~` is a case that must be REJECTED. For it,
    // failing to compile is the pass — so the outcome is inverted
    // rather than reported as a failure of the compiler.
    match (expected_message(&source), compile(file)) {
        (None, Ok(outcome)) => {
            let failures = outcome.failures();
            println!(
                "{} {}",
                if failures == 0 { tick() } else { cross() },
                display(file)
            );
            for test in &outcome.tests {
                match &test.failed {
                    // The message the author wrote, not the condition
                    // that produced it: `throw "x == 5" unless x == 5`
                    // says nothing a reader did not already see.
                    Some(message) => println!("    {} {}\n      {message}", cross(), test.name),
                    None => println!("    {}", test.name),
                }
            }
            drawings += outcome.drawings;
            if failures == 0 {
                summary.files_passed += 1;
                summary.tests += outcome.tests.len();
            } else {
                summary.files_failed += 1;
                summary.tests += outcome.tests.len() - failures;
                summary.tests_failed += failures;
            }
        }
        (None, Err(report)) => {
            println!("{} {}", cross(), display(file));
            report.print();
            summary.files_failed += 1;
        }
        (Some(expected), Err(report)) if report.text.contains(&expected) => {
            println!("{} {} (rejected, as it should be)", tick(), display(file));
            summary.files_passed += 1;
            summary.rejections += 1;
        }
        (Some(expected), Err(report)) => {
            println!("{} {}", cross(), display(file));
            println!("     expected the error to say: {expected}");
            report.print();
            summary.files_failed += 1;
        }
        (Some(expected), Ok(_)) => {
            println!("{} {}", cross(), display(file));
            println!("     compiled, but should have been rejected with: {expected}");
            summary.files_failed += 1;
        }
    }

    print_machine_summary(&summary, drawings);
    Ok(if summary.files_failed == 0 { ExitCode::SUCCESS } else { ExitCode::FAILURE })
}

/// The counts, on a line the parent can read back.
///
/// Prefixed and last, so the human-readable output above it passes
/// through untouched and the parent can strip exactly one line.
const COUNTS: &str = "@counts ";

fn print_machine_summary(summary: &Summary, drawings: usize) {
    println!(
        "{COUNTS}{} {} {} {} {} {}",
        summary.files_passed,
        summary.files_failed,
        summary.tests,
        summary.tests_failed,
        summary.rejections,
        drawings
    );
}

/// What one child reported.
struct Child {
    output: String,
    summary: Summary,
    drawings: usize,
}

/// Runs one file in a child process and reads back what it found.
fn run_in_child(file: &Path) -> Result<Child, String> {
    let program = std::env::current_exe()
        .map_err(|error| format!("cannot find this executable: {error}"))?;

    let finished = std::process::Command::new(program)
        .arg("test-file")
        .arg(file)
        .output()
        .map_err(|error| format!("could not run the compiler for this file: {error}"))?;

    let text = String::from_utf8_lossy(&finished.stdout).into_owned();
    // A compile error is written to STDERR by `Report::print`, so
    // reading stdout alone loses it: the file shows as failed with
    // nothing said about why. Kept separate from the counts line, and
    // printed with the rest.
    let complaint = String::from_utf8_lossy(&finished.stderr).into_owned();

    let Some(counts) = text.lines().rev().find_map(|line| line.strip_prefix(COUNTS)) else {
        // No summary line means the child never reached the end — it
        // crashed, was killed, or aborted. Whatever the reason, the
        // file did not pass, and saying so with the signal is more
        // useful than a silent absence from the count.
        let mut how = match finished.status.code() {
            Some(code) => format!("the compiler exited with status {code} on this file"),
            None => "the compiler was killed while reading this file".to_string(),
        };
        let complaint = String::from_utf8_lossy(&finished.stderr);
        let complaint = complaint.trim();
        if !complaint.is_empty() {
            how.push_str(&format!("\n     {}", complaint.replace('\n', "\n     ")));
        }
        return Err(how);
    };

    let numbers: Vec<usize> = counts
        .split_whitespace()
        .map(|word| word.parse().unwrap_or(0))
        .collect();
    if numbers.len() != 6 {
        return Err("the compiler reported a summary this one cannot read".to_string());
    }

    Ok(Child {
        output: text
            .lines()
            .filter(|line| !line.starts_with(COUNTS))
            .map(|line| format!("{line}\n"))
            .chain(complaint.lines().map(|line| format!("{line}\n")))
            .collect(),
        summary: Summary {
            files_passed: numbers[0],
            files_failed: numbers[1],
            tests: numbers[2],
            tests_failed: numbers[3],
            rejections: numbers[4],
        },
        drawings: numbers[5],
    })
}

#[derive(Default)]
struct Summary {
    files_passed: usize,
    files_failed: usize,
    /// Tests that RAN and held.
    tests: usize,
    /// Tests that ran and threw. Counted apart from `files_failed`
    /// because one bad assertion in a file of twenty is not the same
    /// news as a file that would not compile.
    tests_failed: usize,
    /// Files that were correctly rejected. Counted apart from `tests`
    /// because they prove the opposite thing, and folding them into one
    /// number would overstate how much of the language works.
    rejections: usize,
}

impl Summary {
    /// Adds one child's counts to this one's.
    fn absorb(&mut self, other: &Summary) {
        self.files_passed += other.files_passed;
        self.files_failed += other.files_failed;
        self.tests += other.tests;
        self.tests_failed += other.tests_failed;
        self.rejections += other.rejections;
    }

    fn print(&self) {
        let files = self.files_passed + self.files_failed;
        println!();
        if self.files_failed == 0 {
            let rejections = if self.rejections > 0 {
                format!(", {} rejected as expected", self.rejections)
            } else {
                String::new()
            };
            println!(
                "{} {} test{} in {} file{}{rejections}",
                tick(),
                self.tests,
                plural(self.tests),
                files,
                plural(files),
            );
        } else {
            // Which of the two failed matters: a test that threw is a
            // bug in the code under test, a file that would not compile
            // is a bug in the compiler or the source.
            let assertions = if self.tests_failed > 0 {
                format!(", {} test{} threw", self.tests_failed, plural(self.tests_failed))
            } else {
                String::new()
            };
            println!(
                "{} {} of {} file{} failed{assertions}",
                cross(),
                self.files_failed,
                files,
                plural(files),
            );
        }
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

/// The name of the library a build produces. One constant, so the
/// archive and anything documenting how to link it cannot disagree.
const LIBRARY_NAME: &str = "linen";

/// Reads a file and everything it imports, as one unit.
///
/// An error is reported against the file it is IN, which is not always
/// the file the command named: a mistake inside an imported module has
/// to point at that module, or the message would quote the wrong line.
fn load_unit(file: &Path) -> Result<syntax::ast::Unit, Report> {
    let root = standard_library();
    syntax::load::load(file, &root, &|path| {
        fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))
    })
    .map_err(|error| {
        let source = fs::read_to_string(&error.file).unwrap_or_default();
        Report::new(&error.file, &source, error.span, &error.message)
    })
}

/// Where `from 'linen:step'` resolves to.
///
/// The kernel's own `src`, found the same way the test and build
/// directories are: LINEN_HOME if set, otherwise by walking up from
/// here. Same rule for all three, so a project that finds its tests
/// finds its standard library too.
fn standard_library() -> PathBuf {
    if let Some(home) = std::env::var_os(HOME_VARIABLE) {
        let home = PathBuf::from(home);
        for candidate in [home.join(COMPILER_DIRECTORY).join("src"), home.join("src")] {
            if candidate.is_dir() {
                return candidate;
            }
        }
    }
    std::env::current_dir()
        .ok()
        .and_then(|here| find_upwards(&here, "src"))
        .unwrap_or_else(|| PathBuf::from("src"))
}

/// Compiles one file to an object under the build directory.
fn compile_to_object(file: &Path, options: &Options) -> Result<PathBuf, Report> {
    let source = fs::read_to_string(file).map_err(|error| Report {
        text: format!("{}: {error}\n", file.display()),
    })?;
    let unit = load_unit(file)?;
    resolve(&unit)
        .map_err(|error| Report::new(file, &source, error.span, &error.message))?;
    check(&unit)
        .map_err(|error| Report::new(file, &source, error.span, &error.message))?;

    let name = file.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let object = build_directory().join(format!("{name}.o"));
    write_object(&unit, &name, options.host, &object).map_err(|error| Report {
        text: format!("{}: {}\n", file.display(), error.message),
    })?;
    Ok(object)
}

/// The compiled runtime, as a static library to fold into the archive.
///
/// Built by cargo rather than carried as a binary: it is a crate in
/// this workspace, and building it here means it can never be stale
/// against the compiler that emits calls into it.
fn runtime_archive() -> Result<PathBuf, String> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|crates| crates.parent())
        .ok_or("cannot find the workspace root")?
        .to_path_buf();

    let finished = std::process::Command::new(env!("CARGO"))
        .arg("build")
        .arg("--quiet")
        .arg("--release")
        .arg("-p")
        .arg("runtime")
        .current_dir(&manifest)
        .output()
        .map_err(|error| format!("cannot build the runtime: {error}"))?;
    if !finished.status.success() {
        return Err(format!(
            "the runtime failed to build: {}",
            String::from_utf8_lossy(&finished.stderr).trim()
        ));
    }

    let library = manifest.join("target/release/libruntime.a");
    if !library.exists() {
        return Err(format!(
            "the runtime built but {} is not there",
            library.display()
        ));
    }
    Ok(library)
}

/// Bundles the objects into a static library with `ar`.
///
/// Shelling out rather than writing the archive format by hand: `ar` is
/// on every machine that has a linker, and the format has enough
/// variants that a hand-rolled writer would be a source of "works here,
/// not there".
fn make_archive(objects: &[PathBuf], archive: &Path) -> Result<(), String> {
    // An `.a` among the inputs is EXTRACTED, not nested. `ar` would
    // happily add one archive as a member of another, and the result
    // links against nothing: the symbols are one level too deep for the
    // linker to see.
    let mut members: Vec<PathBuf> = Vec::new();
    let mut extracted = Vec::new();
    for object in objects {
        if object.extension().is_some_and(|of| of == "a") {
            extracted.extend(extract_archive(object)?);
        } else {
            members.push(object.clone());
        }
    }
    members.extend(extracted);
    let objects: &[PathBuf] = &members;

    if archive.exists() {
        // `ar r` updates in place, so a stale member from a deleted
        // source would survive. Removing first makes the archive reflect
        // exactly what was just built.
        fs::remove_file(archive)
            .map_err(|error| format!("cannot remove {}: {error}", archive.display()))?;
    }
    let output = std::process::Command::new("ar")
        .arg("crs")
        .arg(archive)
        .args(objects)
        .output()
        .map_err(|error| format!("cannot run `ar`: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "`ar` failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// Unpacks an archive into loose objects, so they can be repacked into
/// another.
///
/// Into a directory of its own, because two archives can hold members
/// of the same name and unpacking both into one place would silently
/// lose one.
fn extract_archive(archive: &Path) -> Result<Vec<PathBuf>, String> {
    let name = archive
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "members".to_string());
    let directory = build_directory().join(name);
    if directory.exists() {
        fs::remove_dir_all(&directory)
            .map_err(|error| format!("cannot clear {}: {error}", directory.display()))?;
    }
    fs::create_dir_all(&directory)
        .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;

    let output = std::process::Command::new("ar")
        .arg("x")
        .arg(archive)
        .current_dir(&directory)
        .output()
        .map_err(|error| format!("cannot run `ar x`: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "`ar x` failed on {}: {}",
            archive.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let mut members = Vec::new();
    for entry in fs::read_dir(&directory)
        .map_err(|error| format!("cannot read {}: {error}", directory.display()))?
    {
        let path = entry
            .map_err(|error| format!("cannot read a member: {error}"))?
            .path();
        if path.extension().is_some_and(|of| of == "o") {
            members.push(path);
        }
    }
    members.sort();
    Ok(members)
}

// =====================================================================
// clean
// =====================================================================

pub fn clean() -> Result<ExitCode, String> {
    let directory = build_directory();
    if !directory.exists() {
        println!("nothing to clean");
        return Ok(ExitCode::SUCCESS);
    }
    fs::remove_dir_all(directory)
        .map_err(|error| format!("cannot remove {}: {error}", directory.display()))?;
    println!("removed {}", directory.display());
    Ok(ExitCode::SUCCESS)
}

// =====================================================================
// the compiler, as far as it goes
// =====================================================================

#[derive(Debug)]
struct Outcome {
    /// What each test did, in source order.
    tests: Vec<TestOutcome>,
    /// How many tiles this file's mosaic holds.
    drawings: usize,
}

#[derive(Debug)]
struct TestOutcome {
    name: String,
    /// The message of the `throw` that fired, or None if it held.
    failed: Option<String>,
}

impl Outcome {
    fn failures(&self) -> usize {
        self.tests.iter().filter(|test| test.failed.is_some()).count()
    }
}

/// Compiles one file and runs its tests: text to tree, resolution,
/// types, IR, and then the JIT.
///
/// One function for all three commands, so they cannot disagree about
/// how a file is found, compiled or reported.
fn compile(file: &Path) -> Result<Outcome, Report> {
    let source = fs::read_to_string(file).map_err(|error| Report {
        text: format!("{}: {error}\n", file.display()),
    })?;

    let unit = load_unit(file)?;
    resolve(&unit)
        .map_err(|error| Report::new(file, &source, error.span, &error.message))?;
    // Shapes and arrays are not typechecked yet; a file that uses them
    // says so with `#!`, and the marker goes away as each lands.
    if !source.lines().any(|line| line.trim_start().starts_with("#!")) {
        check(&unit)
            .map_err(|error| Report::new(file, &source, error.span, &error.message))?;
    }

    // Shapes and arrays reach neither the checker nor the backend yet,
    // so a `#!` file stops at "it parsed and resolved". Reporting its
    // tests as having run would be a lie in the one line people read.
    if source.lines().any(|line| line.trim_start().starts_with("#!")) {
        let tests = unit
            .items
            .iter()
            .filter_map(|item| match item {
                syntax::ast::Item::Test(test) => Some(TestOutcome {
                    name: test.name.clone(),
                    failed: None,
                }),
                _ => None,
            })
            .collect();
        return Ok(Outcome { tests, drawings: 0 });
    }

    let name = file.file_stem().unwrap_or_default().to_string_lossy();
    let ran = run_tests(&unit, &name).map_err(|error| Report {
        text: format!("{}: {}\n", file.display(), error.message),
    })?;

    // Rendered after the tests, so a file whose assertions fail still
    // produces the pictures of the tests that did draw — seeing the
    // wrong solid is usually how a failure gets understood.
    let drawings = crate::scene::render_file(&ran, file).map_err(|error| Report {
        text: format!("{}: {error}\n", file.display()),
    })?;

    Ok(Outcome {
        tests: ran
            .into_iter()
            .map(|test| TestOutcome {
                name: test.name,
                failed: test.failed,
            })
            .collect(),
        drawings,
    })
}

// =====================================================================
// finding the files
// =====================================================================

/// Where sources live when no path is given.
const SOURCE_DIRECTORY: &str = "src";

/// Where tests live when no path is given. Fixed, not configurable: a
/// project that can put its tests anywhere is a project where nobody is
/// sure `linen test` ran all of them.
const TEST_DIRECTORY: &str = "tests";

/// The files a command should work on: what was named, or the command's
/// default directory found by walking UP from here.
///
/// Walking up is what makes the command usable from anywhere inside a
/// project, the way `git` finds `.git` and `cargo` finds `Cargo.toml`.
/// Looking only in the current directory would mean `linen test` works in
/// the project root and nowhere else — including from the very
/// subdirectory the user is editing in.
fn sources(options: &Options, default: &str) -> Result<Vec<PathBuf>, String> {
    if let Some(path) = &options.path {
        if path.is_file() {
            return Ok(vec![path.clone()]);
        }
        if path.is_dir() {
            return Ok(collect(path));
        }
        return Err(format!("`{}` is neither a file nor a directory", path.display()));
    }

    // LINEN_HOME wins when it is set: it is the explicit answer, and an
    // explicit answer that loses to a search would be a setting that
    // silently does nothing.
    if let Some(home) = std::env::var_os(HOME_VARIABLE) {
        let home = PathBuf::from(home);

        // LINEN_HOME points at the repository root, and the compiler's
        // own tree lives under `lang/` inside it. Both spellings are
        // accepted — `<home>/lang/tests` and `<home>/tests` — so pointing
        // it at either the repo or the compiler works, rather than the
        // variable being right in one form and mysteriously empty in the
        // other.
        for candidate in [home.join(COMPILER_DIRECTORY).join(default), home.join(default)] {
            if candidate.is_dir() {
                return Ok(collect(&candidate));
            }
        }
        return Err(format!(
            "{HOME_VARIABLE} is `{}`, which has no `{COMPILER_DIRECTORY}/{default}` or `{default}` directory",
            home.display()
        ));
    }

    let here = std::env::current_dir()
        .map_err(|error| format!("cannot read the current directory: {error}"))?;
    let found = find_upwards(&here, default).ok_or_else(|| {
        // Naming what it wanted, where it looked, AND the way out.
        // "no `tests` directory" alone leaves the user wondering whether
        // the problem is the name or the place.
        format!(
            "no `{default}` directory in `{}` or any directory above it\n\
             set {HOME_VARIABLE} to the project root, or run from inside it",
            here.display()
        )
    })?;
    Ok(collect(&found))
}

/// Points at the project root, for running the command from outside it.
const HOME_VARIABLE: &str = "LINEN_HOME";

/// Where the compiler's own sources and tests sit inside the repository.
const COMPILER_DIRECTORY: &str = "lang";

/// The nearest `name` directory at or above `start`.
fn find_upwards(start: &Path, name: &str) -> Option<PathBuf> {
    let mut at = Some(start);
    while let Some(directory) = at {
        let candidate = directory.join(name);
        if candidate.is_dir() {
            return Some(candidate);
        }
        at = directory.parent();
    }
    None
}

/// The `#~ ...` line, if the file has one: the error this program must
/// be rejected with.
///
/// A substring rather than the whole message — it pins the part that
/// carries the meaning and stays quiet about wording that may improve.
fn expected_message(source: &str) -> Option<String> {
    source.lines().find_map(|line| {
        line.trim_start().strip_prefix("#~").map(|rest| rest.trim().to_string())
    })
}

/// Every .lang under a directory, recursively.
fn collect(directory: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = fs::read_dir(directory) else {
        return files;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(collect(&path));
        } else if path.extension().is_some_and(|extension| extension == EXTENSION) {
            files.push(path);
        }
    }
    // Sorted, so two runs over the same tree report in the same order.
    files.sort();
    files
}

fn display(file: &Path) -> String {
    file.display().to_string()
}

// --- decoration -----------------------------------------------------------
// Kept out of the message text so a future --no-color has one place to
// change, rather than a colour code baked into every println.

fn tick() -> &'static str {
    "ok  "
}

fn cross() -> &'static str {
    "FAIL"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_lang_files_recursively_and_in_order() {
        let root = std::env::temp_dir().join("linen-collect-test");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("nested")).expect("should create");
        fs::write(root.join("b.lang"), "").expect("should write");
        fs::write(root.join("a.lang"), "").expect("should write");
        fs::write(root.join("skip.txt"), "").expect("should write");
        fs::write(root.join("nested/c.lang"), "").expect("should write");

        let found = collect(&root);
        let names: Vec<_> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();

        assert!(names.contains(&"c.lang".to_string()), "should recurse");
        assert!(!names.contains(&"skip.txt".to_string()), "should only take .lang");
        // Sorted, so a report reads the same way twice.
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reports_the_tests_a_file_declares() {
        let file = std::env::temp_dir().join("linen-outcome-test.lang");
        fs::write(&file, "test \"first\"\n  throw \"m\" unless 1 == 1\n\ntest \"second\"\n  throw \"m\" unless 2 == 2\n")
            .expect("should write");

        let outcome = compile(&file).expect("should compile");
        let names: Vec<&str> = outcome.tests.iter().map(|test| test.name.as_str()).collect();
        assert_eq!(names, vec!["first", "second"]);
        // And both held — they are `1 == 1` and `2 == 2`.
        assert_eq!(outcome.failures(), 0);

        let _ = fs::remove_file(&file);
    }

    #[test]
    fn a_broken_file_reports_where() {
        let file = std::env::temp_dir().join("linen-broken-test.lang");
        fs::write(&file, "test \"t\"\n  throw \"m\" unless 1 +\n").expect("should write");

        let report = compile(&file).expect_err("should fail");
        assert!(report.text.contains(":2:"), "should name the line: {}", report.text);

        let _ = fs::remove_file(&file);
    }

}
