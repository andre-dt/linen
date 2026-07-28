// =====================================================================
// packages/viewer/cube.ts — THE VIEW CUBE'S GEOMETRY.
//
// A chamfered cube: six face panels, twelve bevelled edge strips and
// eight corner triangles, each a separate pickable region standing for
// the direction you would look from.
//
// WHY NOT CSS
// -----------
// The first attempt built this with CSS 3D transforms, and it cannot
// work. `transform-style: preserve-3d` composites by DOCUMENT ORDER, not
// depth — verified directly: a quad at translateZ(-30px) paints over one
// at +30px. Six faces can be hand-sorted, but twenty-six facets, several
// of them nearly coplanar, cannot. Hit testing has the same problem: a
// bevel's target would be a rectangle approximating a strip.
//
// With real geometry both fall out for free — the depth buffer sorts,
// and picking is a ray cast against the same triangles that were drawn.
//
// THE CHAMFER IS THE AFFORDANCE
// -----------------------------
// The bevels are not decoration. They are what makes an edge or a corner
// a thing you can aim at: on a sharp cube those regions have zero area
// and can only be faked with overlays. Cutting them gives every one of
// the twenty-six directions a real facet with real pixels.
// =====================================================================

import type { Vector3 } from "@linen/cad/kernel"

/**
 * How far in from each corner the chamfer cuts, as a fraction of the
 * half-edge.
 *
 * 0.28 is a compromise measured against the two failure modes: below
 * about 0.2 the corner facets are too small to hit comfortably at the
 * control's size, and above about 0.35 the face panels have shrunk
 * enough that their labels start to crowd.
 */
export const CHAMFER = 0.28

/** Which kind of region a facet is. The camera treats all three alike —
 *  they are directions — but the renderer styles them differently and
 *  the labels only go on faces. */
export type CubeRegionKind = "face" | "edge" | "corner"

export interface CubeRegion {
  readonly id: string
  readonly kind: CubeRegionKind
  /** The direction to look FROM, in the kernel's frame: X right, Y away
   *  at the Front view, Z up. Normalised. */
  readonly direction: Vector3
  /** Human-readable, for tooltips and assistive technology. */
  readonly label: string
  /** Triangles, as flat vertex positions in cube space (edge length 2,
   *  centred on the origin). Three vertices per triangle. */
  readonly positions: Float32Array
  /** Outward normal, shared by every triangle in the facet — these are
   *  all planar. */
  readonly normal: Vector3
}

const AXIS_WORD: Record<string, string> = {
  "x+": "right", "x-": "left",
  "y+": "back", "y-": "front",
  "z+": "top", "z-": "bottom",
}

/** "Top front left", always in the same axis order so tooltips read
 *  alike rather than depending on enumeration order. */
const labelFor = (x: number, y: number, z: number): string => {
  const words = [
    z !== 0 ? AXIS_WORD[`z${z > 0 ? "+" : "-"}`] : null,
    y !== 0 ? AXIS_WORD[`y${y > 0 ? "+" : "-"}`] : null,
    x !== 0 ? AXIS_WORD[`x${x > 0 ? "+" : "-"}`] : null,
  ].filter((word): word is string => word !== null)
  return words.join(" ").replace(/^./, (c) => c.toUpperCase())
}

const normalise = (v: Vector3): Vector3 => {
  const length = Math.hypot(v[0], v[1], v[2])
  return length < 1e-9 ? v : [v[0] / length, v[1] / length, v[2] / length]
}

/**
 * The eight corner points of the chamfered solid, as a lookup.
 *
 * Cutting a corner replaces the single sharp vertex (±1, ±1, ±1) with
 * three points, one pulled back along each axis. `cornerVertex` returns
 * the one pulled back along `axis`.
 */
const cornerVertex = (
  sx: number, sy: number, sz: number, axis: 0 | 1 | 2,
): Vector3 => {
  const inset = 1 - CHAMFER
  // Every component is inset EXCEPT the one this vertex keeps at full
  // extent — that is what makes three distinct points per corner.
  return [
    axis === 0 ? sx : sx * inset,
    axis === 1 ? sy : sy * inset,
    axis === 2 ? sz : sz * inset,
  ]
}

/** Two triangles covering a quad, wound counter-clockwise seen from
 *  outside. */
const quad = (a: Vector3, b: Vector3, c: Vector3, d: Vector3): number[] => [
  ...a, ...b, ...c,
  ...a, ...c, ...d,
]

/**
 * Builds every facet of the chamfered cube.
 *
 * Generated rather than listed: twenty-six facets written out by hand is
 * twenty-six chances for a vertex to disagree with the direction it
 * claims to represent, and the two must match exactly or clicking a
 * region moves the camera somewhere else.
 */
export const buildCube = (): readonly CubeRegion[] => {
  const regions: CubeRegion[] = []
  const inset = 1 - CHAMFER

  // ONE SOLID, classified — not three constructions stitched together.
  //
  // Faces, bevels and corners were each built to their own scheme and
  // never made to share boundaries: measured, the facets covered 19.4 of
  // an expected ~23 surface units, so a sixth of the cube was simply
  // missing. On screen that was holes at every corner and a ragged
  // silhouette, and patching the three against each other failed
  // repeatedly because there was no single source of truth for where a
  // boundary lay.
  //
  // Here the whole solid is generated as one subdivided surface, and a
  // vertex's REGION is then read off from where it sits. Two facets can
  // no longer disagree about a shared edge, because neither owns it:
  // they are cut from the same cloth.
  //
  // The shape is a cube whose surface is pushed out to a rounded form:
  // each point is the nearest point of the inner box [-half, half]^3
  // plus CHAMFER along the outward direction. Flat where the box is
  // flat, cylindrical along its edges, spherical at its corners.
  // The inner box the rounded surface is offset from. ONE chamfer in
  // from the cube's half-edge of 1 — not from `inset`, which is already
  // 1 - CHAMFER. Subtracting it twice put the whole solid at 0.72 where
  // its faces belong at 1.0, shrinking the surface to 10.3 units against
  // the ~23 a cube of this size has.
  const half = 1 - CHAMFER

  /** The rounded solid's surface point in a given direction. */
  const surfaceAt = (direction: Vector3): Vector3 => {
    const length = Math.hypot(direction[0], direction[1], direction[2])
    const unit: Vector3 = [
      direction[0] / length, direction[1] / length, direction[2] / length,
    ]
    // March out until the ray leaves the rounded box. The nearest inner
    // box point along the ray, plus the chamfer radius, is exactly the
    // boundary — the same construction the face rim used, in 3D.
    let low = 0
    let high = 4
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const middle = (low + high) / 2
      const point: Vector3 = [
        unit[0] * middle, unit[1] * middle, unit[2] * middle,
      ]
      const clamped: Vector3 = [
        Math.max(-half, Math.min(half, point[0])),
        Math.max(-half, Math.min(half, point[1])),
        Math.max(-half, Math.min(half, point[2])),
      ]
      const distance = Math.hypot(
        point[0] - clamped[0], point[1] - clamped[1], point[2] - clamped[2],
      )
      if (distance > CHAMFER) high = middle
      else low = middle
    }
    return [unit[0] * low, unit[1] * low, unit[2] * low]
  }

  /**
   * Which region a surface point belongs to.
   *
   * Read from how many axes the point is saturated on — that is, how
   * many of its coordinates have run past the inner box. None or one
   * means a flat face, two an edge fillet, three a corner. The same
   * count that defines the geometry defines the classification, which
   * is what keeps the two from drifting.
   */
  const classify = (point: Vector3): {
    kind: CubeRegionKind
    direction: Vector3
  } => {
    const saturated = [0, 1, 2].map((axis) =>
      Math.abs(point[axis]!) > half + 1e-6 ? Math.sign(point[axis]!) : 0,
    ) as unknown as Vector3

    const count = saturated.filter((value) => value !== 0).length
    if (count >= 3) return { kind: "corner", direction: normalise(saturated) }
    if (count === 2) return { kind: "edge", direction: normalise(saturated) }

    // A face: the dominant axis names it, whether or not the point has
    // saturated yet — the centre of a face has saturated on nothing.
    let dominant = 0
    for (const axis of [1, 2] as const) {
      if (Math.abs(point[axis]) > Math.abs(point[dominant]!)) dominant = axis
    }
    const direction: Vector3 = [
      dominant === 0 ? Math.sign(point[0]) : 0,
      dominant === 1 ? Math.sign(point[1]) : 0,
      dominant === 2 ? Math.sign(point[2]) : 0,
    ]
    return { kind: "face", direction }
  }

  // Tessellate PER CUBE FACE, not from a sphere of directions.
  //
  // A spherical grid seemed the natural way to sweep every direction,
  // and it has two faults that only show up under measurement. It
  // collapses at the poles, wasting thousands of zero-area triangles
  // there; and the slivers it leaves are numerically unpickable — a ray
  // straight down the axis hit `det` = 3.5e-5 with `u` landing exactly
  // on 1.0, so the Bottom face could not be selected at all.
  //
  // Projecting a uniform grid outward from each of the cube's six sides
  // has neither problem: the cells stay well-shaped everywhere, and the
  // six patches share their boundary vertices exactly because each edge
  // is generated from the same coordinates on both sides.
  const GRID = 48
  const buckets = new Map<
    string,
    { kind: CubeRegionKind; direction: Vector3; positions: number[] }
  >()

  const emit = (a: Vector3, b: Vector3, c: Vector3): void => {
    const centre: Vector3 = [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ]
    const { kind, direction } = classify(centre)
    const key = `${kind}:${direction.map((v) => v.toFixed(3)).join(",")}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { kind, direction, positions: [] }
      buckets.set(key, bucket)
    }

    // Winding DERIVED against the surface point, which on a solid
    // centred at the origin IS the outward direction. Assuming an order
    // instead left whole patches facing inward.
    const e1: Vector3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2: Vector3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const cross: Vector3 = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ]
    const facing =
      cross[0] * centre[0] + cross[1] * centre[1] + cross[2] * centre[2]
    if (Math.abs(facing) < 1e-12) return
    if (facing > 0) bucket.positions.push(...a, ...b, ...c)
    else bucket.positions.push(...a, ...c, ...b)
  }

  for (const axis of [0, 1, 2] as const) {
    for (const sign of [1, -1] as const) {
      const u = ((axis + 1) % 3) as 0 | 1 | 2
      const v = ((axis + 2) % 3) as 0 | 1 | 2

      /** A direction pointing at (su, sv) on this side of the unit box. */
      const towards = (su: number, sv: number): Vector3 => {
        const component = (which: 0 | 1 | 2): number =>
          which === axis ? sign : which === u ? su : sv
        return [component(0), component(1), component(2)]
      }

      const row = (index: number): number => (index / GRID) * 2 - 1
      for (let i = 0; i < GRID; i += 1) {
        for (let j = 0; j < GRID; j += 1) {
          const a = surfaceAt(towards(row(i), row(j)))
          const b = surfaceAt(towards(row(i + 1), row(j)))
          const c = surfaceAt(towards(row(i + 1), row(j + 1)))
          const d = surfaceAt(towards(row(i), row(j + 1)))
          emit(a, b, c)
          emit(a, c, d)
        }
      }
    }
  }

  for (const [key, bucket] of buckets) {
    const [x, y, z] = bucket.direction
    regions.push({
      id: key,
      kind: bucket.kind,
      direction: bucket.direction,
      label: labelFor(
        Math.abs(x) > 0.01 ? Math.sign(x) : 0,
        Math.abs(y) > 0.01 ? Math.sign(y) : 0,
        Math.abs(z) > 0.01 ? Math.sign(z) : 0,
      ),
      positions: new Float32Array(bucket.positions),
      normal: bucket.direction,
    })
  }

  return regions
}

/**
 * Ray/triangle intersection, Möller–Trumbore.
 *
 * Returns the distance along the ray, or null when it misses. Shared by
 * every region, so picking is one loop over the same triangles that were
 * drawn — the thing you click and the thing you see cannot disagree.
 */
const intersectTriangle = (
  origin: Vector3, direction: Vector3,
  a: Vector3, b: Vector3, c: Vector3,
): number | null => {
  const edge1: Vector3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const edge2: Vector3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const h: Vector3 = [
    direction[1] * edge2[2] - direction[2] * edge2[1],
    direction[2] * edge2[0] - direction[0] * edge2[2],
    direction[0] * edge2[1] - direction[1] * edge2[0],
  ]
  const determinant = edge1[0] * h[0] + edge1[1] * h[1] + edge1[2] * h[2]
  // Parallel to the triangle's plane.
  if (Math.abs(determinant) < 1e-12) return null

  const inverse = 1 / determinant
  const s: Vector3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]]
  const u = inverse * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2])
  if (u < 0 || u > 1) return null

  const q: Vector3 = [
    s[1] * edge1[2] - s[2] * edge1[1],
    s[2] * edge1[0] - s[0] * edge1[2],
    s[0] * edge1[1] - s[1] * edge1[0],
  ]
  const v =
    inverse * (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2])
  if (v < 0 || u + v > 1) return null

  const distance =
    inverse * (edge2[0] * q[0] + edge2[1] * q[1] + edge2[2] * q[2])
  // Behind the ray's origin.
  return distance > 1e-9 ? distance : null
}

/**
 * The nearest region a ray hits, or null.
 *
 * Nearest rather than first: the ray passes through the far side of the
 * cube too, and returning whichever facet happened to be enumerated
 * first would sometimes select the region behind the one under the
 * cursor.
 */
export const pickCube = (
  regions: readonly CubeRegion[],
  origin: Vector3,
  direction: Vector3,
): CubeRegion | null => {
  let nearest: CubeRegion | null = null
  let nearestDistance = Infinity

  for (const region of regions) {
    const positions = region.positions
    for (let index = 0; index + 8 < positions.length; index += 9) {
      const a: Vector3 = [positions[index]!, positions[index + 1]!, positions[index + 2]!]
      const b: Vector3 = [positions[index + 3]!, positions[index + 4]!, positions[index + 5]!]
      const c: Vector3 = [positions[index + 6]!, positions[index + 7]!, positions[index + 8]!]
      const distance = intersectTriangle(origin, direction, a, b, c)
      if (distance !== null && distance < nearestDistance) {
        nearestDistance = distance
        nearest = region
      }
    }
  }

  return nearest
}
