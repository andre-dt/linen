// =====================================================================
// compile/object.rs — AN ARTIFACT SOMETHING ELSE CAN LINK.
//
// The JIT proves a program computes. This proves the compiler can hand
// its output to another toolchain — which is the whole requirement for
// the kernel being callable from Node, or from anything that is not
// this compiler.
//
// WHAT IS VISIBLE, AND WHY IT IS A DECISION
// -----------------------------------------
// Only `export fn` becomes a visible symbol. Everything else is
// internal, which does two things at once:
//
//   - what a caller outside the language can reach stays deliberate,
//     and a helper can be renamed without breaking whoever linked it
//   - LLVM may inline, specialise or delete an internal function,
//     because nothing outside the module can observe that it existed
//
// The second is not a micro-optimisation. A kernel is small functions
// calling small functions — `orient2d` inside `triangle_area` inside a
// loop — and if none of them could be inlined, the call overhead would
// be most of the work.
//
// NO NAME MANGLING
// ----------------
// An exported function keeps its written name: `orient2d` is the symbol
// `orient2d`. A C header can then declare it by hand, which is what the
// N-API layer needs. The cost is that two units cannot export the same
// name — which is a real constraint, and the right one for a boundary
// that a human writes a header against.
// =====================================================================

use std::path::Path;

use inkwell::context::Context;
use inkwell::module::Linkage;
use inkwell::targets::{
    CodeModel, FileType, InitializationConfig, RelocMode, Target, TargetMachine,
};
use inkwell::OptimizationLevel;

use syntax::ast::{Item, Unit};

use crate::emit::{emit, EmitError};
use crate::host::Host;

/// Compiles a unit to an object file at `path`.
pub fn write_object(
    unit: &Unit,
    module_name: &str,
    host: Host,
    path: &Path,
) -> Result<(), EmitError> {
    let context = Context::create();
    let compiled = emit(&context, unit, module_name)?;
    let module = compiled.module;

    // Everything is external by default in LLVM. Walking the unit and
    // demoting what was not exported is what makes the boundary real —
    // and it has to happen before verification, so a malformed module is
    // reported as malformed rather than as a link error later.
    for item in &unit.items {
        if let Item::Function(function) = item {
            if function.exported {
                continue;
            }
            if let Some(value) = module.get_function(&function.name) {
                value.set_linkage(Linkage::Internal);
            }
        }
    }

    // A test compiles into the module too, and it is never part of a
    // boundary — `linen.test.0` is an implementation detail of `linen
    // test`. Internal, so it does not appear in a library's symbol table.
    for test in &compiled.tests {
        if let Some(value) = module.get_function(&test.symbol) {
            value.set_linkage(Linkage::Internal);
        }
    }

    module.verify().map_err(|error| EmitError {
        message: format!("the generated code is malformed: {}", error.to_string().trim()),
    })?;

    let machine = machine_for(host)?;

    // The data layout has to come from the machine, not be assumed: it
    // decides struct padding and alignment, and a module that disagrees
    // with the target about those produces an object that links and then
    // reads fields at the wrong offsets.
    module.set_triple(&machine.get_triple());
    module.set_data_layout(&machine.get_target_data().get_data_layout());

    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory).map_err(|error| EmitError {
            message: format!("cannot make {}: {error}", directory.display()),
        })?;
    }

    machine
        .write_to_file(&module, FileType::Object, path)
        .map_err(|error| EmitError {
            message: format!("cannot write {}: {error}", path.display()),
        })
}

/// The target machine for a host.
fn machine_for(host: Host) -> Result<TargetMachine, EmitError> {
    Target::initialize_all(&InitializationConfig::default());

    let triple = inkwell::targets::TargetTriple::create(host.triple());
    let target = Target::from_triple(&triple).map_err(|error| EmitError {
        message: format!("no backend for {}: {error}", host.triple()),
    })?;

    target
        .create_target_machine(
            &triple,
            // Generic rather than the host's exact CPU: an object built
            // on one machine has to run on another, and `native` here
            // would bake in whatever instructions this particular
            // machine happens to have.
            "generic",
            "",
            // Aggressive, because the kernel is small functions calling
            // small functions and inlining is most of what it buys.
            OptimizationLevel::Aggressive,
            // Position-independent, so the object can go into a shared
            // library — which is what an N-API addon is.
            RelocMode::PIC,
            CodeModel::Default,
        )
        .ok_or_else(|| EmitError {
            message: format!("cannot make a target machine for {}", host.triple()),
        })
}
