// =====================================================================
// Linking the kernel into the addon.
//
// `liblinen.a` is what `linen build` produces from lang/src. It is
// linked STATICALLY: an addon that needed a .so beside it would have to
// find that .so at runtime, and "works on my machine" is exactly what a
// deployed cloud function cannot afford.
// =====================================================================

use std::path::PathBuf;

fn main() {
    napi_build::setup();

    // Relative to this crate, so the build works from any directory.
    let kernel = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../lang/build")
        .canonicalize()
        .expect("run `linen build` first: lang/build/liblinen.a is missing");

    println!("cargo:rustc-link-search=native={}", kernel.display());
    println!("cargo:rustc-link-lib=static=linen");
    // Rebuilt when the kernel changes, or an addon would keep linking a
    // stale copy after `linen build`.
    println!("cargo:rerun-if-changed={}/liblinen.a", kernel.display());
}
