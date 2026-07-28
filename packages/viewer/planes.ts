// =====================================================================
// packages/viewer/planes.ts — THE DATUM PLANES, as clickable surfaces.
//
// A draft has to start somewhere, and before any body exists the only
// thing to start on is a datum plane. So the viewport draws the six of
// them and lets the user click one, exactly as Onshape does.
//
// NAMED BY VIEW, NOT BY AXIS PAIR
// -------------------------------
// The user thinks "the top of the part", not "the XY plane". The names
// here are Top / Bottom / Front / Back / Left / Right, and each carries
// the axis plane it actually means — the naming is presentation, the
// geometry underneath is still Z-up right-handed like the kernel.
//
// Top and Bottom are the SAME geometric plane seen from opposite sides,
// as are Front/Back and Left/Right. They are distinct choices because
// the sketch's own orientation differs — which way is "up" in the
// two-dimensional space, and which way the normal points.
//
// PICKING IS A RAY CAST
// ---------------------
// The cursor is unprojected into a world-space ray and intersected with
// each plane analytically: a plane is an infinite flat surface, so there
// is a closed-form answer and no need for triangles or a BVH. The hit is
// then bounds-checked against the drawn quad, because the user can only
// click what they can see.
//
// This is the same ray the mesh picker will use once bodies exist; the
// difference is only what it intersects against.
// =====================================================================

import type { Vector3 } from "@linen/cad/kernel"
import type { Matrix } from "./math"
import { cross, dot, normalize, subtract } from "./math"

// =====================================================================
// 1. THE PLANES
// =====================================================================

export type DatumPlaneId =
  | "top" | "bottom" | "front" | "back" | "left" | "right"

export interface DatumPlane {
  readonly id: DatumPlaneId
  readonly label: string
  /** The axis plane it lies in — what gets persisted, since the kernel
   *  speaks geometry rather than view names. */
  readonly axes: "XY" | "XZ" | "YZ"
  /** Unit normal. Opposite for the paired planes (top vs bottom), which
   *  is the whole reason both exist. */
  readonly normal: Vector3
  /** In-plane axes: where "right" and "up" point for two-dimensional
   *  coordinates drawn on it. */
  readonly right: Vector3
  readonly up: Vector3
  /** Tint, so the three orientations stay distinguishable at a glance.
   *  Conventional: X red, Y green, Z blue — the axis each plane faces. */
  readonly color: readonly [number, number, number]
}

export const DATUM_PLANES: readonly DatumPlane[] = [
  {
    id: "top", label: "Top", axes: "XY",
    normal: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0],
    color: [0.36, 0.55, 0.98],
  },
  {
    id: "bottom", label: "Bottom", axes: "XY",
    normal: [0, 0, -1], right: [1, 0, 0], up: [0, -1, 0],
    color: [0.36, 0.55, 0.98],
  },
  {
    id: "front", label: "Front", axes: "XZ",
    normal: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1],
    color: [0.42, 0.78, 0.5],
  },
  {
    id: "back", label: "Back", axes: "XZ",
    normal: [0, 1, 0], right: [-1, 0, 0], up: [0, 0, 1],
    color: [0.42, 0.78, 0.5],
  },
  {
    id: "right", label: "Right", axes: "YZ",
    normal: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1],
    color: [0.92, 0.45, 0.45],
  },
  {
    id: "left", label: "Left", axes: "YZ",
    normal: [-1, 0, 0], right: [0, -1, 0], up: [0, 0, 1],
    color: [0.92, 0.45, 0.45],
  },
]

export const datumPlane = (id: DatumPlaneId): DatumPlane =>
  DATUM_PLANES.find((plane) => plane.id === id) ?? DATUM_PLANES[0]!

/** Half-width of the drawn square, in millimetres. Only the DRAWN extent
 *  — the plane itself is infinite, and a sketch may run past the square. */
export const PLANE_EXTENT = 60

// =====================================================================
// 2. RAY CASTING
// =====================================================================

export interface Ray {
  readonly origin: Vector3
  readonly direction: Vector3
}

export interface PlaneHit {
  readonly plane: DatumPlane
  /** Distance along the ray. The nearest hit wins. */
  readonly distance: number
  /** Where it landed, in world space. */
  readonly point: Vector3
  /** The same point in the plane's own two-dimensional coordinates —
   *  which is what a sketch click actually needs. */
  readonly u: number
  readonly v: number
}

/**
 * Unprojects a cursor position into a world-space ray.
 *
 * Takes the INVERSE view-projection: the forward matrix maps world to
 * clip, so its inverse maps a clip-space point back out. Two points on
 * the near and far planes define the ray between them, which works for
 * perspective and orthographic alike — under orthographic the two share
 * no common origin, so deriving the direction from the pair rather than
 * from the camera position is what keeps both correct.
 */
export const rayThrough = (
  x: number,
  y: number,
  width: number,
  height: number,
  inverseViewProjection: Matrix,
): Ray => {
  // Pixels -> normalised device coordinates. Y flips: the DOM counts
  // downward from the top, clip space counts upward from the centre.
  const clipX = (x / width) * 2 - 1
  const clipY = 1 - (y / height) * 2

  const near = unproject(clipX, clipY, -1, inverseViewProjection)
  const far = unproject(clipX, clipY, 1, inverseViewProjection)

  return { origin: near, direction: normalize(subtract(far, near)) }
}

const unproject = (
  x: number,
  y: number,
  z: number,
  inverse: Matrix,
): Vector3 => {
  // Column-major, matching the matrices the camera builds.
  const w = inverse[3]! * x + inverse[7]! * y + inverse[11]! * z + inverse[15]!
  // A zero w means the point is on the camera plane and has no world
  // position. Guarding keeps a degenerate matrix from producing NaN
  // coordinates that would silently poison every later comparison.
  const scale = w === 0 ? 1 : 1 / w
  return [
    (inverse[0]! * x + inverse[4]! * y + inverse[8]! * z + inverse[12]!) * scale,
    (inverse[1]! * x + inverse[5]! * y + inverse[9]! * z + inverse[13]!) * scale,
    (inverse[2]! * x + inverse[6]! * y + inverse[10]! * z + inverse[14]!) * scale,
  ]
}

/**
 * Intersects a ray with the datum planes and returns the nearest hit
 * that lands inside the drawn square.
 *
 * All six planes pass through the origin, so the intersection reduces to
 * `-dot(origin, normal) / dot(direction, normal)`. A near-zero
 * denominator means the ray is parallel to the plane — no hit, rather
 * than a division that yields Infinity.
 *
 * Back-facing planes are skipped: a plane is one-sided here, which is
 * what makes Top and Bottom separately clickable. Whichever of the pair
 * currently faces the camera is the one the user can hit.
 */
export const pickPlane = (
  ray: Ray,
  planes: readonly DatumPlane[] = DATUM_PLANES,
  extent: number = PLANE_EXTENT,
): PlaneHit | null => {
  let nearest: PlaneHit | null = null

  for (const plane of planes) {
    const facing = dot(ray.direction, plane.normal)
    // > 0 means the ray travels WITH the normal, hitting the back.
    if (facing > -1e-6) continue

    const distance = -dot(ray.origin, plane.normal) / facing
    if (distance <= 0) continue
    if (nearest && distance >= nearest.distance) continue

    const point: Vector3 = [
      ray.origin[0] + ray.direction[0] * distance,
      ray.origin[1] + ray.direction[1] * distance,
      ray.origin[2] + ray.direction[2] * distance,
    ]

    // Only the drawn square is clickable: the user cannot click what is
    // not on screen, however infinite the plane is in principle.
    const u = dot(point, plane.right)
    const v = dot(point, plane.up)
    if (Math.abs(u) > extent || Math.abs(v) > extent) continue

    nearest = { plane, distance, point, u, v }
  }

  return nearest
}

// =====================================================================
// 3. GEOMETRY
// =====================================================================

/**
 * The drawn square for a plane: two triangles, wound so the front face
 * points along the normal. Winding is what makes back-face culling agree
 * with the one-sided picking above — if they disagreed, the user could
 * click a plane they cannot see.
 */
export const planeQuad = (
  plane: DatumPlane,
  extent: number = PLANE_EXTENT,
): Float32Array => {
  const corner = (u: number, v: number): readonly number[] => [
    plane.right[0] * u * extent + plane.up[0] * v * extent,
    plane.right[1] * u * extent + plane.up[1] * v * extent,
    plane.right[2] * u * extent + plane.up[2] * v * extent,
  ]

  // right x up must equal the normal for the winding to come out
  // front-facing; the table above is built so it does.
  const a = corner(-1, -1)
  const b = corner(1, -1)
  const c = corner(1, 1)
  const d = corner(-1, 1)

  return new Float32Array([...a, ...b, ...c, ...a, ...c, ...d])
}

/**
 * A ruled grid across the plane, as line segments.
 *
 * This is most of what makes an empty viewport read as three-dimensional
 * space rather than as a flat coloured shape: the lines converge under
 * perspective, and that convergence is the depth cue. Onshape, Fusion and
 * SolidWorks all draw one for the same reason.
 *
 * The two centre lines are omitted — they are the axes, drawn separately
 * and more brightly, and doubling them up makes the origin muddy.
 */
export const planeGrid = (
  plane: DatumPlane,
  extent: number = PLANE_EXTENT,
  step = 10,
): Float32Array => {
  const out: number[] = []
  const at = (u: number, v: number): void => {
    out.push(
      plane.right[0] * u + plane.up[0] * v,
      plane.right[1] * u + plane.up[1] * v,
      plane.right[2] * u + plane.up[2] * v,
    )
  }

  for (let offset = -extent; offset <= extent + 1e-9; offset += step) {
    // Skip the centre: the axes cover it.
    if (Math.abs(offset) < 1e-9) continue
    at(offset, -extent)
    at(offset, extent)
    at(-extent, offset)
    at(extent, offset)
  }

  return new Float32Array(out)
}

/**
 * The two in-plane axes, full width. Brighter than the grid so the
 * origin is unmistakable — it is the one point every coordinate is
 * measured from.
 */
export const planeAxes = (
  plane: DatumPlane,
  extent: number = PLANE_EXTENT,
): Float32Array => {
  const at = (u: number, v: number): readonly number[] => [
    plane.right[0] * u + plane.up[0] * v,
    plane.right[1] * u + plane.up[1] * v,
    plane.right[2] * u + plane.up[2] * v,
  ]
  return new Float32Array([
    ...at(-extent, 0), ...at(extent, 0),
    ...at(0, -extent), ...at(0, extent),
  ])
}

/** The square's border, as a line loop: the plane reads as a framed
 *  surface rather than a floating translucent patch. */
export const planeOutline = (
  plane: DatumPlane,
  extent: number = PLANE_EXTENT,
): Float32Array => {
  const quad = planeQuad(plane, extent)
  // Corners a, b, c, d out of the two triangles: 0, 1, 2 and 5.
  const at = (index: number): readonly number[] =>
    [quad[index * 3]!, quad[index * 3 + 1]!, quad[index * 3 + 2]!]
  const [a, b, c, d] = [at(0), at(1), at(2), at(5)]
  return new Float32Array([
    ...a, ...b, ...b, ...c, ...c, ...d, ...d, ...a,
  ])
}

/**
 * The origin marker: a small solid sphere at (0,0,0).
 *
 * Onshape draws a dot there, and it earns its place — it is the one point
 * every coordinate in the model is measured from, and without it the eye
 * has nothing to fix on where the planes intersect.
 *
 * A real 1mm-radius sphere in WORLD units, not a screen-space dot: it is
 * a landmark IN the model, so it should zoom with the model. At the
 * default framing that is roughly eight pixels across.
 *
 * A UV sphere rather than an icosphere: at this size the difference is
 * invisible, and the parameterisation is four lines instead of a
 * subdivision routine. Returned as a triangle list — no index buffer,
 * since a couple of hundred vertices is not worth the second binding.
 */
export const originSphere = (
  radius = ORIGIN_RADIUS,
  segments = 16,
  rings = 12,
): Float32Array => {
  const at = (ring: number, segment: number): readonly number[] => {
    // Polar angle from +Z, azimuth around it.
    const phi = (ring / rings) * Math.PI
    const theta = (segment / segments) * Math.PI * 2
    return [
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
    ]
  }

  // Interleaved x,y,z,nx,ny,nz. On a sphere centred at the origin the
  // surface normal IS the normalised position, so it costs one divide
  // rather than a second pass.
  const out: number[] = []
  const push = (point: readonly number[]): void => {
    out.push(
      point[0]!, point[1]!, point[2]!,
      point[0]! / radius, point[1]! / radius, point[2]! / radius,
    )
  }

  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const a = at(ring, segment)
      const b = at(ring + 1, segment)
      const c = at(ring + 1, segment + 1)
      const d = at(ring, segment + 1)
      // Two triangles per quad. The poles degenerate to slivers, which
      // cost nothing and save special-casing the first and last ring.
      push(a); push(b); push(c)
      push(a); push(c); push(d)
    }
  }
  return new Float32Array(out)
}

/** Radius in millimetres, like every other length in the system. */
export const ORIGIN_RADIUS = 1

/** Vertex count for a sphere of the given tessellation — what the draw
 *  call needs, kept here so the caller never recomputes it wrongly. */
export const originSphereVertexCount = (segments = 16, rings = 12): number =>
  segments * rings * 6

/**
 * A quad for a plane's name label, lying IN the plane at its top-left
 * corner — the position Onshape uses.
 *
 * Returned interleaved as x,y,z,u,v so one buffer feeds both attributes:
 * the label is drawn as a texture, and a second buffer for two floats
 * per vertex would be pure overhead.
 *
 * The quad lives in the plane's own frame, so it SKEWS with the surface
 * as the camera orbits. That is the whole point of stamping the name
 * into the plane rather than floating it over the canvas: it reads as
 * belonging to the geometry, the way a label printed on a drawing does.
 */
export const planeLabelQuad = (
  plane: DatumPlane,
  widthMillimetres: number,
  heightMillimetres: number,
  extent: number = PLANE_EXTENT,
  inset = 2,
  /** Flip the text horizontally. A plane is drawn two-sided, so from one
   *  side its glyphs read backwards; the caller picks the variant that
   *  reads correctly from where the camera actually is. */
  mirrored = false,
): Float32Array => {
  // Always anchored at the plane's own top-left, running right and
  // downward. The QUAD never moves; only the texture is flipped.
  const left = -extent + inset
  const top = extent - inset

  const at = (u: number, v: number): readonly number[] => [
    plane.right[0] * u + plane.up[0] * v,
    plane.right[1] * u + plane.up[1] * v,
    plane.right[2] * u + plane.up[2] * v,
  ]

  const a = at(left, top)                                        // top-left
  const b = at(left + widthMillimetres, top)                     // top-right
  const c = at(left + widthMillimetres, top - heightMillimetres) // bottom-right
  const d = at(left, top - heightMillimetres)                    // bottom-left

  // Mirroring is a TEXTURE flip, not a geometry one.
  //
  // Moving the quad to the far corner and advancing backwards — the
  // obvious first attempt — relocates the label but leaves the glyphs
  // reversed, because each corner still samples the same texel it did
  // before. Swapping U is what actually un-mirrors the text.
  const u0 = mirrored ? 1 : 0
  const u1 = mirrored ? 0 : 1

  // Texture V runs downward, so the top of the quad samples v = 0.
  return new Float32Array([
    ...a, u0, 0, ...b, u1, 0, ...c, u1, 1,
    ...a, u0, 0, ...c, u1, 1, ...d, u0, 1,
  ])
}

/** Sanity check used by the tests: right x up == normal for every plane,
 *  which is what keeps culling and picking agreeing. */
export const planeFrameIsRightHanded = (plane: DatumPlane): boolean => {
  const computed = cross(plane.right, plane.up)
  return (
    Math.abs(computed[0] - plane.normal[0]) < 1e-9 &&
    Math.abs(computed[1] - plane.normal[1]) < 1e-9 &&
    Math.abs(computed[2] - plane.normal[2]) < 1e-9
  )
}
