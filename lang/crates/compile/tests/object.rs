// =====================================================================
// AN OBJECT FILE THAT SOMETHING ELSE CAN LINK.
//
// The JIT proves a program computes the right answer. It does not prove
// the compiler can produce an artifact another toolchain will accept —
// and that is the whole requirement for calling the kernel from Node.
//
// So this compiles to a real .o, links it with cc, and calls it through
// `extern "C"`. Nothing here trusts a declaration: if the ABI is wrong,
// the number comes back wrong or the link fails, and both are visible.
// =====================================================================

use std::path::PathBuf;
use std::process::Command;

use compile::host::Host;
use compile::object::write_object;
use syntax::{lex::lex, parse::parse};

/// Compiles a source to an object file, then links it into a shared
/// library that this test can dlopen.
fn build_library(source: &str, name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("linen-object-{name}"));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).expect("should make a directory");

    let tokens = lex(source).expect("should lex");
    let unit = parse(&tokens).expect("should parse");

    let object = directory.join(format!("{name}.o"));
    write_object(&unit, name, Host::LinuxX64, &object).expect("should write an object");

    assert!(object.exists(), "the object file should exist");
    let size = std::fs::metadata(&object).expect("should stat").len();
    assert!(size > 0, "the object file should not be empty");

    // Linked with `cc`, the same way any other object would be. If the
    // compiler emitted something malformed, this is where it shows.
    let library = directory.join(format!("lib{name}.so"));
    let linked = Command::new("cc")
        .arg("-shared")
        .arg("-o")
        .arg(&library)
        .arg(&object)
        .output()
        .expect("should run cc");
    assert!(
        linked.status.success(),
        "cc failed: {}",
        String::from_utf8_lossy(&linked.stderr)
    );
    library
}

#[test]
fn a_function_can_be_called_from_c() {
    let library = build_library(
        "export fn double(n i32) i64\n  return n * 2\n",
        "callable",
    );

    let library = unsafe { libloading::Library::new(&library) }.expect("should load");
    let double: libloading::Symbol<unsafe extern "C" fn(i32) -> i64> =
        unsafe { library.get(b"double") }.expect("should find `double`");

    assert_eq!(unsafe { double(21) }, 42);
}

#[test]
fn the_widening_rule_holds_across_the_boundary() {
    // Two i32 coordinates multiplied is 10^14 — the case that decided
    // the whole storage model. It has to survive the ABI too, or the
    // kernel is exact right up to the point anybody calls it.
    let library = build_library(
        "export fn area(w i32, h i32) i64\n  return w * h\n",
        "widening",
    );

    let library = unsafe { libloading::Library::new(&library) }.expect("should load");
    let area: libloading::Symbol<unsafe extern "C" fn(i32, i32) -> i64> =
        unsafe { library.get(b"area") }.expect("should find `area`");

    assert_eq!(unsafe { area(10_000_000, 10_000_000) }, 100_000_000_000_000);
}

#[test]
fn a_negative_coordinate_survives_as_negative() {
    // Sign extension, not zero extension. A negative coordinate widened
    // as unsigned becomes an enormous positive — the exact silent
    // wrongness the integer model exists to remove.
    let library = build_library(
        "export fn widen(n i32) i64\n  return n + 0\n",
        "signs",
    );

    let library = unsafe { libloading::Library::new(&library) }.expect("should load");
    let widen: libloading::Symbol<unsafe extern "C" fn(i32) -> i64> =
        unsafe { library.get(b"widen") }.expect("should find `widen`");

    assert_eq!(unsafe { widen(-1) }, -1);
    assert_eq!(unsafe { widen(-10_000_000) }, -10_000_000);
}

#[test]
fn only_exported_functions_are_visible() {
    // A helper is not part of the boundary. Keeping it private is what
    // lets the kernel be refactored without breaking whoever links it.
    let library = build_library(
        "fn helper(n i32) i64\n  return n\n\nexport fn public(n i32) i64\n  return helper(n: n)\n",
        "exports",
    );

    let library = unsafe { libloading::Library::new(&library) }.expect("should load");
    assert!(
        unsafe { library.get::<unsafe extern "C" fn(i32) -> i64>(b"public") }.is_ok(),
        "an exported function should be visible"
    );
    assert!(
        unsafe { library.get::<unsafe extern "C" fn(i32) -> i64>(b"helper") }.is_err(),
        "a helper should NOT be visible outside the object"
    );
}
