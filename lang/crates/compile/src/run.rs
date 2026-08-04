// =====================================================================
// compile/run.rs — RUNNING WHAT WAS EMITTED.
//
// The tests are executed in-process by LLVM's JIT rather than written to
// an object file, linked and spawned. A test suite runs every file on
// every change, and paying a link and a process spawn per file would be
// most of the wall clock for work that produces no artifact anybody
// keeps.
//
// `linen build` is where an object file belongs. `linen test` only needs
// the answer.
//
// WHAT COMES BACK
// ---------------
// A test returns i32: 0 if it held, otherwise the 1-based index of the
// throw that fired. The message for that index lives on the Rust side —
// so a failing assertion can name itself without the compiled code ever
// holding a string, in a language that has no allocator yet.
// =====================================================================

use inkwell::context::Context;
use inkwell::OptimizationLevel;

use syntax::ast::Unit;

use crate::emit::{emit, EmitError};

/// What one test did.
pub struct Ran {
    pub name: String,
    /// The message of the throw that fired, or None if the test held.
    pub failed: Option<String>,
}

/// Compiles a unit and runs every test in it.
pub fn run_tests(unit: &Unit, module_name: &str) -> Result<Vec<Ran>, EmitError> {
    let context = Context::create();
    let compiled = emit(&context, unit, module_name)?;

    // Verification catches malformed IR — a block with two terminators,
    // a phi missing an incoming edge — at the point it was built rather
    // than as a crash inside the JIT, where the message would name an
    // LLVM internal instead of anything in this compiler.
    compiled.module.verify().map_err(|error| EmitError {
        message: format!("the generated code is malformed: {}", error.to_string().trim()),
    })?;

    let engine = compiled
        .module
        .create_jit_execution_engine(OptimizationLevel::None)
        .map_err(|error| EmitError {
            message: format!("could not start the JIT: {error}"),
        })?;

    let mut results = Vec::new();
    for test in &compiled.tests {
        // Safety: the symbol was just emitted with exactly this
        // signature — `fn() -> i32`, no arguments, no state — and the
        // module it came from outlives the call.
        let compiled_test = unsafe {
            engine
                .get_function::<unsafe extern "C" fn() -> i32>(&test.symbol)
                .map_err(|error| EmitError {
                    message: format!("could not find `{}`: {error}", test.symbol),
                })?
        };
        let outcome = unsafe { compiled_test.call() };

        let failed = if outcome == 0 {
            None
        } else {
            // The index is 1-based, so entry 0 is the throw returning 1.
            Some(
                test.messages
                    .get((outcome - 1) as usize)
                    .cloned()
                    .unwrap_or_else(|| format!("throw #{outcome}")),
            )
        };
        results.push(Ran {
            name: test.name.clone(),
            failed,
        });
    }
    Ok(results)
}
