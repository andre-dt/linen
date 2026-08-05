// =====================================================================
// drivers/bytes.rs — TEXT, WHICH THE LANGUAGE HAS NONE OF.
//
// `from 'linen:bytes' use digits` names a function declared in
// `src/bytes.lang` as `driver fn` — a signature with no body. The body
// is here.
//
// WHY ANY OF THIS IS RUST
// -----------------------
// Text and I/O, and nothing else. STEP is a text format:
// `CARTESIAN_POINT('',(0.,0.,0.))` is characters, and the language has
// integers. Formatting a number into ASCII is string work, and building
// strings into the language to serve one file format would be the wrong
// trade — the language exists to express geometry exactly.
//
// The line is firm: a driver never computes geometry. A driver that
// did would make the kernel a thin shell over Rust, which is the
// opposite of the point. Tessellation is `.lang` for exactly this
// reason, even though it would have been faster to write here.
//
// WHY THE SIGNATURE LIVES IN .lang
// --------------------------------
// So the typechecker reads it as it reads any other. A call to
// `digits(value:)` is checked against a declaration, not trusted — and
// the declaration is versioned with the kernel, in the language it is
// called from, rather than hidden in a Rust file the caller never sees.
//
// The two halves must agree or the link fails. That is the property
// worth having: a signature changed on one side alone does not compile.
// =====================================================================

use crate::arena::{allocate_bytes, ListValue};

/// Every driver in this module, for the JIT and the linker.
pub fn table() -> Vec<(&'static str, usize)> {
    vec![
        ("digits", linen_digits as *const () as usize),
        ("ascii", linen_ascii as *const () as usize),
    ]
}

/// `digits(value:)` — the decimal digits of a number, as ASCII bytes.
///
/// The one thing integer arithmetic alone cannot do, and the reason
/// this file exists at all: a STEP file is mostly numbers written out
/// as text.
///
/// Bytes rather than a string, because a `List<i32>` is a type the
/// language already has. The harness turns the finished list into UTF-8
/// when it writes the file.
///
/// # Safety
/// Called from compiled code across the C ABI.
#[no_mangle]
pub extern "C" fn linen_digits(value: i64) -> ListValue {
    let text = value.to_string();
    bytes_of(text.as_bytes())
}

/// `ascii(of:)` — the bytes of a fixed piece of text, by number.
///
/// There is no string literal in the language, so the fragments a STEP
/// file needs are named by index rather than written. Crude on purpose:
/// it is scaffolding that goes away when text lands, and it lets the
/// STEP writer be written in `.lang` today rather than waiting for it.
///
/// An unknown number gives an empty list rather than failing. A
/// fragment that does not exist produces nothing, which shows up as a
/// malformed file the round-trip test catches — better than a crash
/// with no test name attached.
///
/// # Safety
/// Called from compiled code across the C ABI.
#[no_mangle]
pub extern "C" fn linen_ascii(of: i32) -> ListValue {
    bytes_of(fragment(of).as_bytes())
}

/// The fixed pieces of text a STEP file is made of.
///
/// Numbered rather than named, because the caller is `.lang` and can
/// only pass an integer. The numbers are an implementation detail
/// shared with `src/bytes.lang`, which gives each one a named function
/// so no caller writes a bare number.
fn fragment(which: i32) -> &'static str {
    match which {
        0 => "",
        1 => "\n",
        2 => ";",
        3 => "=",
        4 => "#",
        5 => "(",
        6 => ")",
        7 => ",",
        8 => "'",
        9 => ".",
        10 => " ",
        11 => "ISO-10303-21",
        12 => "HEADER",
        13 => "FILE_DESCRIPTION",
        14 => "FILE_NAME",
        15 => "FILE_SCHEMA",
        16 => "ENDSEC",
        17 => "DATA",
        18 => "END-ISO-10303-21",
        19 => "CARTESIAN_POINT",
        20 => "DIRECTION",
        21 => "VERTEX_POINT",
        22 => "LINE",
        23 => "VECTOR",
        24 => "EDGE_CURVE",
        25 => "ORIENTED_EDGE",
        26 => "EDGE_LOOP",
        27 => "FACE_OUTER_BOUND",
        28 => "ADVANCED_FACE",
        29 => "CLOSED_SHELL",
        30 => "MANIFOLD_SOLID_BREP",
        31 => "PLANE",
        32 => "AXIS2_PLACEMENT_3D",
        33 => "POLY_LINE",
        34 => ".T.",
        35 => ".F.",
        _ => "",
    }
}

/// Copies bytes into the arena as a `List<i32>`, one element per byte.
///
/// One byte per i32 rather than four packed: a STEP file is ASCII, the
/// lists are short-lived, and unpacking in `.lang` would need shifts
/// the language has no operators for. Four times the memory for a file
/// measured in kilobytes is not a trade worth making complicated.
fn bytes_of(bytes: &[u8]) -> ListValue {
    let count = bytes.len();
    if count == 0 {
        return ListValue {
            length: 0,
            elements: std::ptr::null(),
        };
    }
    let space = allocate_bytes(count * 4) as *mut i32;
    for (index, byte) in bytes.iter().enumerate() {
        // Safety: `space` has room for `count` i32s, just allocated.
        unsafe { space.add(index).write(*byte as i32) };
    }
    ListValue {
        length: count as i32,
        elements: space as *const u8,
    }
}
