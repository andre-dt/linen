// =====================================================================
// compile — THE BACKEND.
//
// AST in, machine code out. The only crate that links LLVM, which is why
// it is a crate of its own: everything in `syntax` rebuilds in under a
// second, and it would not if it lived here.
// =====================================================================

pub mod emit;
pub mod host;
pub mod object;
pub mod run;

// The arena and the drivers live in `runtime`, which builds without
// LLVM: they are linked into a compiled kernel, and a kernel should not
// carry a compiler. Re-exported so callers keep one path to them.
pub use runtime::{arena, drivers};
