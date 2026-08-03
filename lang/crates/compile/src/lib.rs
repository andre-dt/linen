// =====================================================================
// compile — THE BACKEND.
//
// AST in, machine code out. The only crate that links LLVM, which is why
// it is a crate of its own: everything in `syntax` rebuilds in under a
// second, and it would not if it lived here.
// =====================================================================

pub mod host;
