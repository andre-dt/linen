// =====================================================================
// runtime — WHAT A COMPILED KERNEL NEEDS AT RUN TIME.
//
// Everything the generated code calls by name: the arena that Lists
// live in, and every `linen:` driver.
//
// No LLVM here, deliberately. This is what gets linked INTO a kernel,
// and a kernel that dragged a compiler along with it would be a strange
// thing to ship.
// =====================================================================

pub mod arena;
pub mod drivers;
