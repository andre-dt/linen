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
    /// The mesh it drew, if it is a `test draws` that reached its
    /// `solid` call. A test that throws before drawing has none — which
    /// is right: there is nothing to look at.
    pub mesh: Option<Mesh>,
}

/// Points and indices, as the compiled code handed them over.
pub struct Mesh {
    /// x, y, z per point.
    pub points: Vec<i32>,
    /// The indices — three per triangle for a solid, two per line for a
    /// wire. Which it is, `kind` says.
    pub triangles: Vec<i32>,
    pub kind: MeshKind,
}

/// What a drawing statement handed over.
///
/// A wire exists because a DRAFT has no inside: an open path encloses
/// nothing, so there is nothing to shade, and drawing it as a solid
/// would show an empty tile.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MeshKind {
    Solid,
    Wire,
}

// The mesh most recently handed over by a `solid` statement.
//
// A global, because the compiled code calls a plain C function with no
// context pointer to carry anything else through. Confined to this
// module and read immediately after the call that fills it, so the
// window where it matters is one function call wide.
//
// Not thread-safe, and not pretending to be: `run_tests` runs one test
// at a time by design — a suite that interleaves is a suite whose
// failures depend on scheduling.
thread_local! {
    static DRAWN: std::cell::RefCell<Option<Mesh>> = const { std::cell::RefCell::new(None) };
}

/// Called BY the compiled code. Copies the mesh out before the arrays,
/// which live on the compiled function's stack, go away.
unsafe extern "C" fn receive_solid(
    points: *const i32,
    point_count: i32,
    triangles: *const i32,
    triangle_count: i32,
    kind: i32,
) {
    // An empty list is a length of zero and a NULL pointer — it never
    // allocated, because nothing would read it. `from_raw_parts` will
    // not take null even for a length of zero, so the empty case is
    // handled here rather than made to allocate for nothing.
    let points = copy_out(points, point_count);
    let triangles = copy_out(triangles, triangle_count);
    DRAWN.with(|drawn| {
        *drawn.borrow_mut() = Some(Mesh {
            points,
            triangles,
            kind: if kind == 1 { MeshKind::Wire } else { MeshKind::Solid },
        });
    });
}

/// Copies `count` elements out, tolerating the null an empty list has.
///
/// # Safety
/// `from` points to `count` readable i32s, or is null with a count of
/// zero.
unsafe fn copy_out(from: *const i32, count: i32) -> Vec<i32> {
    let count = count.max(0) as usize;
    if count == 0 || from.is_null() {
        return Vec::new();
    }
    std::slice::from_raw_parts(from, count).to_vec()
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

    // The runtime side of a `solid` statement. Mapped before any test
    // runs, or the first call would find an unresolved symbol.
    if let Some(declared) = compiled.module.get_function(crate::emit::SOLID_SYMBOL) {
        engine.add_global_mapping(&declared, receive_solid as *const () as usize);
    }

    // And the arena, for the List builtins.
    for (name, address) in [
        ("linen_list_new", crate::arena::linen_list_new as *const () as usize),
        ("linen_list_push", crate::arena::linen_list_push as *const () as usize),
        ("linen_list_length", crate::arena::linen_list_length as *const () as usize),
        ("linen_list_at", crate::arena::linen_list_at as *const () as usize),
        ("linen_check_index", crate::arena::linen_check_index as *const () as usize),
    ] {
        if let Some(declared) = compiled.module.get_function(name) {
            engine.add_global_mapping(&declared, address);
        }
    }

    // And the standard library's drivers — the `linen:` modules, whose
    // signatures are `.lang` and whose bodies are Rust.
    for (name, address) in crate::drivers::table() {
        // Under the same prefix the emitter used. The JIT would map any
        // name to any address, which is exactly why the two drifted
        // apart unnoticed until a static link failed.
        let symbol = format!("{}{name}", crate::emit::DRIVER_PREFIX);
        if let Some(declared) = compiled.module.get_function(&symbol) {
            engine.add_global_mapping(&declared, address);
        }
    }

    let mut results = Vec::new();
    for test in &compiled.tests {
        DRAWN.with(|drawn| *drawn.borrow_mut() = None);
        // Nothing survives the test that allocated it.
        crate::arena::reset_arena();
        crate::drivers::reset();
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

        // An out-of-range read outranks a throw that did not fire. The
        // test may well have finished and reported nothing wrong —
        // having read a zero that was never in the list.
        let faulted = crate::arena::take_fault();

        let failed = if let Some(fault) = faulted {
            Some(fault)
        } else if outcome == 0 {
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
            mesh: DRAWN.with(|drawn| drawn.borrow_mut().take()),
        });
    }
    Ok(results)
}

/// Calls a no-argument function returning a fixed array of i32, and
/// copies the elements out.
///
/// How a test hands its geometry to the renderer. The array is returned
/// BY VALUE — the size is in the type, so there is no allocation and
/// nothing to free — which means the caller has to know how big it is:
/// that comes from the declared type, not from the value.
pub fn run_exported_array(unit: &Unit, name: &str) -> Result<Vec<i32>, EmitError> {
    let size = declared_array_size(unit, name)?;

    let context = Context::create();
    let compiled = emit(&context, unit, "scene")?;
    compiled.module.verify().map_err(|error| EmitError {
        message: format!("the generated code is malformed: {}", error.to_string().trim()),
    })?;

    let engine = compiled
        .module
        .create_jit_execution_engine(OptimizationLevel::None)
        .map_err(|error| EmitError {
            message: format!("could not start the JIT: {error}"),
        })?;

    // Called through a pointer to a caller-provided buffer rather than
    // by value: an array returned by value crosses the ABI as a hidden
    // out-parameter on some targets and in registers on others, and
    // guessing which is how a boundary produces silent nonsense.
    //
    // The wrapper below is emitted for exactly this purpose, so the
    // shape of the call is known rather than assumed.
    let symbol = format!("linen.scene.{name}");
    let function = unsafe {
        engine
            .get_function::<unsafe extern "C" fn(*mut i32)>(&symbol)
            .map_err(|error| EmitError {
                message: format!("could not find `{symbol}`: {error}"),
            })?
    };

    let mut out = vec![0i32; size];
    unsafe { function.call(out.as_mut_ptr()) };
    Ok(out)
}

/// How many elements the function's declared return type holds.
fn declared_array_size(unit: &Unit, name: &str) -> Result<usize, EmitError> {
    for item in &unit.items {
        if let syntax::ast::Item::Function(function) = item {
            if function.name != name {
                continue;
            }
            let result = function.result.as_ref().ok_or_else(|| EmitError {
                message: format!("`{name}` returns nothing, so it has no scene to draw"),
            })?;
            let size = result.array_size.ok_or_else(|| EmitError {
                message: format!("`{name}` has to return a fixed array"),
            })?;
            return Ok(size as usize);
        }
    }
    Err(EmitError {
        message: format!("there is no `{name}` here"),
    })
}
