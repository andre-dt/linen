// =====================================================================
// The kernel, as TypeScript sees it.
//
// Written by hand rather than generated, because it is the boundary and
// a boundary deserves the same care as the header it mirrors. Every
// coordinate is a whole number of MICRONS.
//
// Results that can exceed 2^53 are `bigint`, not `number`. A JS number
// stops being exact past 2^53, and the products here reach 10^14 — so
// returning a number would silently lose the exactness the whole
// integer kernel exists to provide.
// =====================================================================

/**
 * Twice the signed area of a triangle, in square microns.
 *
 * Twice, and never halved: the doubled value is always a whole number
 * where the halved one is not, and comparing areas or testing a winding
 * is unaffected by the constant factor.
 *
 * Positive when the points wind counter-clockwise, negative clockwise,
 * and exactly zero when they are collinear.
 */
export function doubleArea(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): bigint

/**
 * The squared distance between two points, in square microns.
 *
 * Squared, and never the root: a square root leaves the integers, and
 * comparing distances or testing a tolerance works on the square.
 */
export function distanceSquared(
  ax: number, ay: number,
  bx: number, by: number,
): bigint

/**
 * Which side of a->b the point c falls on.
 *
 *   1  left of a->b, a counter-clockwise turn
 *   0  collinear, EXACTLY
 *  -1  right
 *
 * Zero means collinear with no tolerance involved. In floating point,
 * three points collinear by construction come out as a tiny non-zero
 * determinant, and no epsilon fixes it because the error scales with the
 * magnitude of the inputs.
 */
export function orientation(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): number

/**
 * Twice the signed area of every triangle in a packed buffer.
 *
 * `coordinates` is x, y per point and three points per triangle, so its
 * length must be a multiple of 6. One entry out per triangle, in order.
 *
 * Prefer this to calling {@link doubleArea} in a loop: a typed array
 * crosses into native code without copying, so a buffer of ten thousand
 * triangles costs one crossing instead of ten thousand.
 *
 * @throws if the length is not a multiple of 6 — a wrong length means
 * the caller packed it wrong, and truncating would hide that.
 */
export function doubleAreas(coordinates: Int32Array): BigInt64Array

/**
 * Which side of a->b each point in a buffer falls on.
 *
 * The segment is scalar and the points are a buffer, which is the shape
 * this is used in: classifying many points against one edge.
 *
 * @throws if the buffer length is odd.
 */
export function orientations(
  ax: number, ay: number,
  bx: number, by: number,
  points: Int32Array,
): Int32Array

/**
 * Which side of the plane through a, b, c the point d falls on.
 *
 *   1  above, the side the normal of a->b->c points to
 *   0  COPLANAR, exactly
 *  -1  below
 *
 * The most used predicate in a BREP kernel: every face classification and
 * every boolean operation asks it.
 *
 * Computed in 128-bit integers. The determinant reaches 10^21 at full
 * range, which overflows a 64-bit integer by two orders — and a wrapped
 * determinant does not merely lose precision, it can carry the wrong
 * SIGN, placing a point above a face it is below. Only the sign is
 * returned, because that is what every caller branches on.
 */
export function orientation3(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): number

/**
 * Which side of a plane each point in a buffer falls on.
 *
 * The plane is scalar and the points are a buffer — x, y, z per point,
 * so the length must be a multiple of 3.
 *
 * @throws if the length is not a multiple of 3.
 */
export function orientations3(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  points: Int32Array,
): Int32Array
