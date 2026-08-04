// =====================================================================
// apps/kernel/native — THE ADDON.
//
// Node calls this; this calls the kernel. Nothing here computes
// geometry — every predicate lives in lang/src/kernel.lang, compiled to
// liblinen.a, and this file only carries values across the boundary.
//
// Keeping it that thin is the point. The kernel is exact integer
// arithmetic with tests that pin a single micron at ten metres; if any
// of it were reimplemented here, that would be a second copy to keep
// honest, and the two would eventually disagree.
//
// NARROW IN SURFACE, THICK IN PAYLOAD
// -----------------------------------
// Two shapes of entry point, deliberately:
//
//   scalar   one triangle, for a caller that has one
//   batch    a whole buffer, for a caller that has thousands
//
// The batch form exists because a JS loop calling a native function per
// triangle spends most of its time on the transition, not the work. A
// typed array crosses zero-copy, so one call over ten thousand points
// costs one crossing.
//
//   wrong:  for (t of triangles) kernel.doubleArea(t)
//   right:  kernel.doubleAreas(coordinates)
//
// COORDINATES ARE MICRONS
// -----------------------
// Every i32 is a whole number of microns; 1 micron to 10 metres is 10^7
// units. Products reach 10^14, which is why results are i64 — and i64
// reaches JS as BigInt, because a JS number loses integers past 2^53.
// =====================================================================

use napi::bindgen_prelude::*;
use napi_derive::napi;

// The kernel, as `linen build` emitted it. Declared by hand rather than
// generated: the exported names are unmangled precisely so a header —
// or this block — can name them directly.
extern "C" {
    fn linen_double_area(
        ax: i32,
        ay: i32,
        bx: i32,
        by: i32,
        cx: i32,
        cy: i32,
    ) -> i64;
    fn linen_distance_squared(ax: i32, ay: i32, bx: i32, by: i32) -> i64;
    fn linen_orientation(
        ax: i32,
        ay: i32,
        bx: i32,
        by: i32,
        cx: i32,
        cy: i32,
    ) -> i32;
}

/// How many i32 make up one point, and one triangle. Named rather than
/// written as 2 and 6 at each use, because an off-by-one in a stride is
/// the kind of bug that produces plausible wrong answers.
const COORDINATES_PER_POINT: usize = 2;
const COORDINATES_PER_TRIANGLE: usize = 3 * COORDINATES_PER_POINT;

// =====================================================================
// scalar
// =====================================================================

/// Twice the signed area of one triangle.
///
/// Twice, and never halved: the doubled value is always a whole number
/// where the halved one is not, and comparing areas or testing a winding
/// is unaffected by the factor.
#[napi]
pub fn double_area(
    ax: i32,
    ay: i32,
    bx: i32,
    by: i32,
    cx: i32,
    cy: i32,
) -> i64 {
    unsafe { linen_double_area(ax, ay, bx, by, cx, cy) }
}

/// The squared distance between two points.
///
/// Squared, and never the root: a square root leaves the integers, and
/// comparing distances or testing a tolerance works on the square.
#[napi]
pub fn distance_squared(ax: i32, ay: i32, bx: i32, by: i32) -> i64 {
    unsafe { linen_distance_squared(ax, ay, bx, by) }
}

/// Which side of a->b the point c falls on: 1 left, -1 right, 0
/// collinear.
///
/// Zero means collinear EXACTLY. That is the whole reason the kernel is
/// integer: in floating point three points collinear by construction
/// come out as a tiny non-zero determinant, and no epsilon fixes it,
/// because the error scales with the magnitude of the inputs.
#[napi]
pub fn orientation(
    ax: i32,
    ay: i32,
    bx: i32,
    by: i32,
    cx: i32,
    cy: i32,
) -> i32 {
    unsafe { linen_orientation(ax, ay, bx, by, cx, cy) }
}

// =====================================================================
// batch
// =====================================================================

/// Twice the signed area of every triangle in a packed buffer.
///
/// `coordinates` is x, y per point, three points per triangle. The
/// result is one BigInt64Array entry per triangle, in the same order.
///
/// One crossing for the whole buffer. The scalar form above is correct
/// for one triangle and wrong as a loop: the transition would cost more
/// than the arithmetic.
#[napi]
pub fn double_areas(coordinates: Int32Array) -> Result<BigInt64Array> {
    let values: &[i32] = &coordinates;
    if values.len() % COORDINATES_PER_TRIANGLE != 0 {
        // Rejected rather than truncated. A buffer of the wrong length
        // means the caller packed it wrong, and silently dropping the
        // tail would turn that into a missing triangle nobody notices.
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "a triangle is {COORDINATES_PER_TRIANGLE} coordinates, so the buffer length must be a multiple of it; got {}",
                values.len()
            ),
        ));
    }

    let areas: Vec<i64> = values
        .chunks_exact(COORDINATES_PER_TRIANGLE)
        .map(|t| unsafe { linen_double_area(t[0], t[1], t[2], t[3], t[4], t[5]) })
        .collect();
    Ok(BigInt64Array::new(areas))
}

/// Which side of a->b each point falls on, for a fixed segment.
///
/// The segment is scalar and the points are a buffer, which is the shape
/// this is actually used in: classifying many points against one edge.
#[napi]
pub fn orientations(
    ax: i32,
    ay: i32,
    bx: i32,
    by: i32,
    points: Int32Array,
) -> Result<Int32Array> {
    let values: &[i32] = &points;
    if values.len() % COORDINATES_PER_POINT != 0 {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "a point is {COORDINATES_PER_POINT} coordinates, so the buffer length must be even; got {}",
                values.len()
            ),
        ));
    }

    let sides: Vec<i32> = values
        .chunks_exact(COORDINATES_PER_POINT)
        .map(|p| unsafe { linen_orientation(ax, ay, bx, by, p[0], p[1]) })
        .collect();
    Ok(Int32Array::new(sides))
}
