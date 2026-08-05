// =====================================================================
// cli/format.rs — `linen format`.
//
// Walks the test directory and rewrites each file into the canonical
// order. The ordering itself lives in the `format` crate, which is a
// function from a string to a string — so what it does can be asked
// without a command and without a filesystem.
// =====================================================================

use std::fs;
use std::process::ExitCode;

use crate::run::{display, sources, TEST_DIRECTORY};
use crate::Options;

pub fn format(options: &Options) -> Result<ExitCode, String> {
    let files = sources(options, TEST_DIRECTORY)?;
    let mut changed = 0;

    for file in &files {
        let source = fs::read_to_string(file)
            .map_err(|error| format!("{}: {error}", file.display()))?;
        // A file that does not parse is left alone. Formatting is not
        // the place to report a syntax error — `linen test` does that,
        // with a span and a caret.
        let Ok(formatted) = format::rewrite(&source) else {
            continue;
        };
        if formatted != source {
            fs::write(file, &formatted)
                .map_err(|error| format!("{}: {error}", file.display()))?;
            println!("{}", display(file));
            changed += 1;
        }
    }

    println!(
        "\n{changed} of {} file{} rewritten",
        files.len(),
        if files.len() == 1 { "" } else { "s" }
    );
    Ok(ExitCode::SUCCESS)
}
