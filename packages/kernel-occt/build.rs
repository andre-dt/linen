// =====================================================================
// packages/kernel-occt/build.rs
//
// Locates the pre-compiled OCCT that Conan restored and links it
// statically, then compiles our C++ shim.
//
// LINK ORDER MATTERS. Static archives resolve left to right on the GNU
// linker, so a library must appear BEFORE the ones it depends on.
// OCCT's layering is TK* -> TKernel, and getting this list out of
// order produces undefined-symbol errors that read as if the library
// were missing entirely.
// =====================================================================

use std::{env, path::PathBuf};

/// OCCT modules we actually use, in dependency order.
///
/// This is a deliberately short list: OCCT ships far more, and every
/// extra module inflates the artifact without being called. Adding a
/// feature that needs, say, TKSTEP for import belongs here.
const OCCT_LIBRARIES: &[&str] = &[
    // Modelling algorithms — the ones behind our capabilities.
    "TKBO",       // booleans: union, subtract, intersect
    "TKPrim",     // primitives and extrusion
    "TKOffset",   // shell, thicken, offset
    "TKFillet",   // fillet, chamfer
    "TKFeat",     // local operations
    "TKBool",     // boolean orchestration
    "TKShHealing",// healing after booleans
    "TKTopAlgo",  // topological algorithms
    "TKGeomAlgo", // geometric algorithms
    "TKBRep",     // the boundary representation itself
    "TKGeomBase", // base geometry
    "TKG3d",      // 3D geometry
    "TKG2d",      // 2D geometry
    "TKMath",     // math foundation
    "TKernel",    // must come last: everything above depends on it
];

fn main() {
    // Emits the N-API glue napi-rs needs before anything else runs.
    napi_build::setup();

    let occt_root = env::var("OCCT_ROOT")
        .map(PathBuf::from)
        .expect("OCCT_ROOT is not set — run `conan install` first (see Dockerfile)");

    let include = occt_root.join("include").join("opencascade");
    let lib = occt_root.join("lib");

    assert!(
        lib.join("libTKernel.a").exists(),
        "no static OCCT found under {}. We never build OCCT from source; \
         restore the pre-compiled package with `conan install --build=never`.",
        lib.display()
    );

    // Our C++ shim: the only place OCCT headers are ever included.
    // Everything above this layer sees BodyId integers.
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .include(&include)
        .include("native/include")
        .file("native/src/session.cpp")
        .file("native/src/extrude.cpp")
        .file("native/src/sketch.cpp")
        .file("native/src/tessellate.cpp")
        .file("native/src/errors.cpp")
        .file("native/src/boolean.cpp")
        // OCCT headers are noisy; our own code stays warning-clean.
        .flag_if_supported("-Wno-unused-parameter")
        .flag_if_supported("-Wno-deprecated-declarations")
        .compile("linen_occt_shim");

    println!("cargo:rustc-link-search=native={}", lib.display());
    for library in OCCT_LIBRARIES {
        println!("cargo:rustc-link-lib=static={library}");
    }

    // Transitive dependencies of static OCCT. With a shared build the
    // loader would resolve these; with a static one we must name them.
    println!("cargo:rustc-link-lib=dylib=stdc++");
    println!("cargo:rustc-link-lib=dylib=pthread");
    println!("cargo:rustc-link-lib=dylib=dl");
    println!("cargo:rustc-link-lib=dylib=m");

    println!("cargo:rerun-if-changed=native");
    println!("cargo:rerun-if-env-changed=OCCT_ROOT");
}
