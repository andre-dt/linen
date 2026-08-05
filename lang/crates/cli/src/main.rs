// =====================================================================
// linen — THE ONE COMMAND.
//
//   linen build [file]     compile
//   linen test  [path]     compile and run the tests
//   linen clean            throw away what was built
//
// One binary with subcommands, the way `zig` works, rather than a
// compiler plus a driver plus a test runner. The three share a front end,
// and disagreeing about how they find files or report errors is a bug the
// single binary cannot have.
//
// Arguments are parsed by hand. A dependency for three subcommands and
// two flags would be more code to read than the parsing it replaces.
// =====================================================================

use std::path::{Path, PathBuf};
use std::process::ExitCode;

mod scene;
mod format;
mod report;
mod run;

use compile::host::Host;

const USAGE: &str = "\
linen — the compiler

usage:
  linen build [path]      compile — ./src unless a path is given
  linen test  [path]      compile and run tests — ./tests unless a path is given
  linen format [path]     put tests in the canonical order
  linen clean             remove the build directory

options:
  --target <host>         where the code should run (default: this machine)
  --help                  this text

Without a path, the directory is found by walking up from here, so the
command works from anywhere inside a project. From outside one, set
LINEN_HOME to the repository root:

  export LINEN_HOME=~/dt/linen
";

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();

    match dispatch(&arguments) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("linen: {message}");
            ExitCode::FAILURE
        }
    }
}

fn dispatch(arguments: &[String]) -> Result<ExitCode, String> {
    let Some(command) = arguments.first() else {
        print!("{USAGE}");
        return Ok(ExitCode::SUCCESS);
    };

    if command == "--help" || command == "-h" {
        print!("{USAGE}");
        return Ok(ExitCode::SUCCESS);
    }

    let rest = &arguments[1..];
    match command.as_str() {
        "build" => run::build(&Options::parse(rest)?),
        "test" => run::test(&Options::parse(rest)?),
        // Runs ONE file, for the subprocess `test` spawns per file.
        // Not in the usage text: it is how `test` is implemented, not
        // something to reach for.
        "test-file" => run::test_file(&Options::parse(rest)?),
        "format" => format::format(&Options::parse(rest)?),
        "clean" => run::clean(),
        other => Err(format!(
            "`{other}` is not a command. Try `build`, `test` or `clean`."
        )),
    }
}

/// What every command takes: where to look, and where the result runs.
pub struct Options {
    /// The file or directory named on the command line, if any.
    pub path: Option<PathBuf>,
    pub host: Host,
}

impl Options {
    fn parse(arguments: &[String]) -> Result<Options, String> {
        let mut path = None;
        let mut host = None;
        let mut at = 0;

        while at < arguments.len() {
            let argument = &arguments[at];
            match argument.as_str() {
                "--target" => {
                    let value = arguments.get(at + 1).ok_or_else(|| {
                        format!(
                            "`--target` needs a value, one of: {}",
                            Host::ALL.iter().map(|h| h.triple()).collect::<Vec<_>>().join(", ")
                        )
                    })?;
                    host = Some(Host::parse(value)?);
                    at += 2;
                }
                other if other.starts_with('-') => {
                    return Err(format!("`{other}` is not an option"));
                }
                other => {
                    if path.is_some() {
                        return Err(format!("only one path at a time; got `{other}` as well"));
                    }
                    path = Some(PathBuf::from(other));
                    at += 1;
                }
            }
        }

        Ok(Options {
            path,
            host: match host {
                Some(host) => host,
                None => Host::native()?,
            },
        })
    }
}

/// Where build output goes. One directory, so `clean` is one removal and
/// nothing built ever lands beside the source.
pub const BUILD_DIRECTORY: &str = "build";

pub fn build_directory() -> &'static Path {
    Path::new(BUILD_DIRECTORY)
}
