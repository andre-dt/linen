// =====================================================================
// syntax — SOURCE TEXT INTO AN AST.
//
// Everything from bytes up to a tree lives here, and none of it knows a
// backend exists. That is the seam: `compile` links LLVM and takes
// minutes to build; this crate does not and rebuilds in under a second,
// which is what makes iterating on the grammar bearable.
// =====================================================================

pub mod ast;
pub mod lex;
pub mod parse;
pub mod resolve;
pub mod token;

#[cfg(test)]
mod lex_test;
#[cfg(test)]
mod parse_test;
#[cfg(test)]
mod resolve_test;
