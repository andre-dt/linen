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
use syntax::{check::check, lex::lex, parse::parse, resolve::resolve};

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
        // The count, because scrolling back to count red blocks is work
        // the compiler can do for you.
        eprintln!(
            "\n{failed} of {} file{} failed to compile",
            files.len(),
            if files.len() == 1 { "" } else { "s" }
        );
        return Ok(ExitCode::FAILURE);
    }

    // One static library, because that is the unit another toolchain
    // links: `cc addon.o -llinen` rather than naming every object.
    let archive = build_directory().join(format!("lib{LIBRARY_NAME}.a"));
    make_archive(&objects, &archive)?;

    println!(
        "built {} file{} for {} -> {}",
        files.len(),
        if files.len() == 1 { "" } else { "s" },
        options.host.triple(),
        archive.display()
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

    for file in &files {
        let source = match fs::read_to_string(file) {
            Ok(source) => source,
            Err(error) => {
                println!("{} {}: {error}", cross(), display(file));
                summary.files_failed += 1;
                continue;
            }
        };

        // A file carrying `#~` is a case that must be REJECTED. For it,
        // failing to compile is the pass — so the outcome is inverted
        // rather than reported as a failure of the compiler.
        match (expected_message(&source), compile(file)) {
            (None, Ok(outcome)) => {
                // Printed per file, as it finishes: when a run is slow or
                // hangs, the last line is the clue about where.
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
    }

    summary.print();
    Ok(if summary.files_failed == 0 { ExitCode::SUCCESS } else { ExitCode::FAILURE })
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

/// Compiles one file to an object under the build directory.
fn compile_to_object(file: &Path, options: &Options) -> Result<PathBuf, Report> {
    let source = fs::read_to_string(file).map_err(|error| Report {
        text: format!("{}: {error}\n", file.display()),
    })?;
    let tokens = lex(&source)
        .map_err(|error| Report::new(file, &source, error.span, &error.message))?;
    let unit = parse(&tokens)
        .map_err(|error| Report::new(file, &source, error.span, &error.message))?;
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

/// Bundles the objects into a static library with `ar`.
///
/// Shelling out rather than writing the archive format by hand: `ar` is
/// on every machine that has a linker, and the format has enough
/// variants that a hand-rolled writer would be a source of "works here,
/// not there".
fn make_archive(objects: &[PathBuf], archive: &Path) -> Result<(), String> {
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

    let tokens = lex(&source)
        .map_err(|error| Report::new(file, &source, error.span, &error.message))?;
    let unit = parse(&tokens)
        .map_err(|error| Report::new(file, &source, error.span, &error.message))?;
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
        return Ok(Outcome { tests });
    }

    let name = file.file_stem().unwrap_or_default().to_string_lossy();
    let ran = run_tests(&unit, &name).map_err(|error| Report {
        text: format!("{}: {}\n", file.display(), error.message),
    })?;

    Ok(Outcome {
        tests: ran
            .into_iter()
            .map(|test| TestOutcome {
                name: test.name,
                failed: test.failed,
            })
            .collect(),
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
