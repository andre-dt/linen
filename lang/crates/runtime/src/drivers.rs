// =====================================================================
// compile/drivers.rs — THE STANDARD LIBRARY'S RUST HALF.
//
// Each `linen:drivers/<name>` is a PAIR: `src/drivers/<name>.lang`
// declares the types and signatures with no bodies — a header — and
// `drivers/<name>.rs` here implements them. The `.lang` is what the
// typechecker reads, so a call is checked against a declaration rather
// than trusted, and the declaration is versioned with the kernel in the
// language it is called from.
//
// The two halves must agree or the link fails. That is the property
// worth having: a signature changed on one side alone does not compile.
//
// A BODY NEVER CROSSES AS A STRUCT
// --------------------------------
// Handles and flat integers only. An aggregate crossing the C ABI makes
// its layout a contract between the two sides, and getting that wrong
// is silent corruption rather than a crash. It is the same rule the
// N-API boundary follows, for the same reason.
// =====================================================================

pub mod brep;
pub mod bytes;
pub mod step;

/// Every driver, from every module, as a name and an address.
///
/// One list rather than a registration call per module: a driver
/// missing from either half is a link error rather than something that
/// half works.
pub fn table() -> Vec<(&'static str, usize)> {
    let mut all = Vec::new();
    all.extend(brep::table());
    all.extend(bytes::table());
    all.extend(step::table());
    all
}

/// Throws away every driver's state. Called between tests, with the
/// arena — nothing survives the test that built it.
pub fn reset() {
    brep::reset();
}
