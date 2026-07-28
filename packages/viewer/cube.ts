// =====================================================================
// packages/viewer/cube.ts — THE VIEW CUBE'S GEOMETRY.
//
// Implemented strictly from packages/viewer/cube-spec.md. Read that first;
// any change goes into the SPEC before it comes here.
//
// The cube is HOLLOW and ASSEMBLED, Onshape-style — NOT a solid with a
// classified surface. It is a small set of detached parts floating in cube
// space:
//
//   - 6 face panels  — flat rounded-rectangles, one per cube face.
//   - 8 corner circles — flat discs, one per cube corner.
//
// There are NO edges: no geometry, nothing to draw, nothing to click along
// the cube's edges. The space between the parts is void. A pick ray that
// misses every panel and disc simply passes through — so, facing the Front
// panel, a click in an empty corner gap can hit the Back panel from behind.
// That falls out for free: with no shell in the gaps, there is nothing to
// occlude, and `pickCube` returns the NEAREST part the ray actually hits.
//
// This construction cannot produce the seam/corner artifacts the old
// classified-solid did, because there are no shared or classified
// boundaries — every part is its own clean mesh.
// =====================================================================

import type { Vector3 } from "@linen/cad/kernel"

// --- layout constants (cube-spec.md §3) -------------------------------
// Display values in the cube's own unit space, tuned by eye against the
// widget. Changing one is a SPEC edit first, then here.

/** Distance from the cube centre to each panel's plane. */
export const HALF = 1.0

/** Half-width of a face panel's square (straight run before the arc). A
 *  panel reaches PANEL_HALF + PANEL_CORNER_RADIUS along each axis; with
 *  HALF = 1 that leaves a visible void gap between adjacent panels. */
export const PANEL_HALF = 0.55

/** Radius the front plate's four corners are rounded by. */
export const PANEL_CORNER_RADIUS = 0.16

/** Half-width of the large BACK plate — nearly the full cube face, so its
 *  rounded corners stop just short of the cube's corners (cube-spec.md
 *  §2.1). This is the plain gray backdrop seen through the opposite face's
 *  gaps. */
export const BACK_PANEL_HALF = 0.84

/** Rounding radius of the back plate's corners. */
export const BACK_PANEL_CORNER_RADIUS = 0.16

/** Depth gap between a face's front and back plates so the two coincident
 *  rounded-rects do not z-fight. */
export const PLATE_SEPARATION = 0.004

// Corner disc placement, DERIVED from the panels so it stays correct if
// the panel constants change (cube-spec.md §2.2 & §3). The disc sits at
// the centroid of the three adjacent panels' nearest corner tips, so its
// rim touches all three panels and it sits OUT at the cube corner, not in
// the hollow interior.
//
// A panel's nearest corner tip toward a cube corner is at, on that panel's
// plane, `PANEL_HALF + PANEL_CORNER_RADIUS/√2` on each in-plane axis and
// `HALF` on the face axis. For the +X+Y+Z corner the three tips are
// (HALF, c, c), (c, HALF, c), (c, c, HALF). Their centroid lies on the
// body diagonal; its distance from the origin is CORNER_DISTANCE, and the
// distance from it to a tip is CORNER_RADIUS.
const CORNER_TIP = PANEL_HALF + PANEL_CORNER_RADIUS / Math.SQRT2
/** Distance from the cube centre to a corner disc's centre, along the
 *  body diagonal — the centroid of the three adjacent panel tips. */
export const CORNER_DISTANCE = Math.hypot(
  (HALF + 2 * CORNER_TIP) / 3,
  (CORNER_TIP + HALF + CORNER_TIP) / 3,
  (2 * CORNER_TIP + HALF) / 3,
)
/** Radius of a corner circle — reaches from the disc centroid to each of
 *  the three panel tips, so the rim touches all three panels. */
export const CORNER_RADIUS = (() => {
  const centre = (HALF + 2 * CORNER_TIP) / 3
  // Tip (HALF, CORNER_TIP, CORNER_TIP) minus centroid (centre, centre, centre).
  return Math.hypot(HALF - centre, CORNER_TIP - centre, CORNER_TIP - centre)
})()

/** Segments per circle and per rounded-corner quarter-arc. */
export const CIRCLE_SEGMENTS = 24

/** The parts produced (cube-spec.md §2). "face" is a small labelled FRONT
 *  plate; "back" is the large plain BACK plate of the same face; "corner"
 *  is a corner circle. "edge" is retained in the type for compatibility
 *  but never produced — there are no edge parts (cube-spec.md §2.3). */
export type CubeRegionKind = "face" | "back" | "edge" | "corner"

export interface CubeRegion {
  readonly id: string
  readonly kind: CubeRegionKind
  /** The direction to look FROM, in the kernel's frame: X right, Y away
   *  at the Front view, Z up. Normalised. */
  readonly direction: Vector3
  /** Human-readable, for tooltips and assistive technology. */
  readonly label: string
  /** Triangles, as flat vertex positions in cube space. Three vertices
   *  per triangle. This is both what is drawn and what is picked. */
  readonly positions: Float32Array
  /** Outward normal, shared by every triangle in the part — planar. */
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

const cross = (a: Vector3, b: Vector3): Vector3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

/**
 * A flat mesh living in a plane, built from 2D points mapped through an
 * origin plus two in-plane basis vectors.
 *
 * `contour` is the outline as (u, v) pairs; it is triangulated as a fan
 * from its centroid, which is valid because every outline here (a rounded
 * rectangle, a circle) is convex. Returns flat xyz triangle positions.
 */
const fillPlanarContour = (
  origin: Vector3,
  axisU: Vector3,
  axisV: Vector3,
  contour: readonly (readonly [number, number])[],
  flip = false,
): number[] => {
  const at = (u: number, v: number): Vector3 => [
    origin[0] + axisU[0] * u + axisV[0] * v,
    origin[1] + axisU[1] * u + axisV[1] * v,
    origin[2] + axisU[2] * u + axisV[2] * v,
  ]
  // Centroid of the outline, the fan's shared apex.
  let cu = 0
  let cv = 0
  for (const [u, v] of contour) { cu += u; cv += v }
  cu /= contour.length
  cv /= contour.length
  const centre = at(cu, cv)

  const out: number[] = []
  for (let i = 0; i < contour.length; i += 1) {
    const [u0, v0] = contour[i]!
    const [u1, v1] = contour[(i + 1) % contour.length]!
    const p0 = at(u0, v0)
    const p1 = at(u1, v1)
    // `flip` reverses the winding, so a plate can be made to face the
    // opposite way (the inward-facing back plate) from the same contour.
    if (flip) {
      out.push(
        centre[0], centre[1], centre[2],
        p1[0], p1[1], p1[2],
        p0[0], p0[1], p0[2],
      )
    } else {
      out.push(
        centre[0], centre[1], centre[2],
        p0[0], p0[1], p0[2],
        p1[0], p1[1], p1[2],
      )
    }
  }
  return out
}

/** The (u, v) outline of a rounded rectangle centred at the origin, half
 *  width `half` on both axes, corners rounded by `radius`. The straight
 *  run reaches `half`; each corner is a quarter-arc of `radius` OUTSIDE
 *  it, so the panel spans `half + radius`. */
const roundedRectContour = (
  half: number, radius: number, segments: number,
): [number, number][] => {
  const points: [number, number][] = []
  // Four corners, each a quarter circle. Centres sit at (±half, ±half);
  // the arc sweeps the outer quadrant so the seams land on the straight
  // edges. Order: +u+v, -u+v, -u-v, +u-v — counter-clockwise.
  const corners: [number, number, number][] = [
    [half, half, 0],       // start angle 0     -> 90
    [-half, half, Math.PI / 2],
    [-half, -half, Math.PI],
    [half, -half, (3 * Math.PI) / 2],
  ]
  for (const [cx, cy, start] of corners) {
    for (let s = 0; s <= segments; s += 1) {
      const angle = start + (s / segments) * (Math.PI / 2)
      points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius])
    }
  }
  return points
}

/** The (u, v) outline of a circle of `radius`, `segments` around. */
const circleContour = (
  radius: number, segments: number,
): [number, number][] => {
  const points: [number, number][] = []
  for (let s = 0; s < segments; s += 1) {
    const angle = (s / segments) * Math.PI * 2
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius])
  }
  return points
}

/**
 * Builds the hollow, assembled view cube: 6 face panels + 8 corner
 * circles, each a detached planar mesh. No shell, no edges.
 */
export const buildCube = (): readonly CubeRegion[] => {
  const regions: CubeRegion[] = []

  // --- 6 face panels (cube-spec.md §2.1) ------------------------------
  // One per signed axis. The panel lies in the face plane at distance
  // HALF, a rounded square in the two in-plane axes.
  /** A unit vector with `value` on `axis`, zero elsewhere. */
  const onAxis = (axis: 0 | 1 | 2, value: number): Vector3 => [
    axis === 0 ? value : 0,
    axis === 1 ? value : 0,
    axis === 2 ? value : 0,
  ]

  for (const axis of [0, 1, 2] as const) {
    for (const sign of [1, -1] as const) {
      const normal = onAxis(axis, sign)
      const u = ((axis + 1) % 3) as 0 | 1 | 2
      const v = ((axis + 2) % 3) as 0 | 1 | 2
      // The in-plane basis handedness MUST follow the outward normal, or
      // the winding (axisU x axisV) points outward on the +axis faces and
      // INWARD on the -axis faces — which made three faces show the wrong
      // plate under back-face culling, breaking the effect on half the
      // cube. Flipping axisV by `sign` keeps axisU x axisV = outward
      // normal on all six faces, so every face behaves identically.
      const axisU = onAxis(u, 1)
      const axisV = onAxis(v, sign)
      const direction = normalise(normal)
      const label = labelFor(
        axis === 0 ? sign : 0,
        axis === 1 ? sign : 0,
        axis === 2 ? sign : 0,
      )

      // FRONT plate: the small labelled rounded-rect, facing OUT. Sits a
      // hair proud of the face plane so it wins over the back plate.
      const frontOrigin: Vector3 = [
        normal[0] * (HALF + PLATE_SEPARATION),
        normal[1] * (HALF + PLATE_SEPARATION),
        normal[2] * (HALF + PLATE_SEPARATION),
      ]
      const frontPositions = fillPlanarContour(
        frontOrigin, axisU, axisV,
        roundedRectContour(PANEL_HALF, PANEL_CORNER_RADIUS, CIRCLE_SEGMENTS),
      )
      regions.push({
        id: `face:${normal.join(",")}`,
        kind: "face",
        direction,
        label,
        positions: new Float32Array(frontPositions),
        normal: direction,
      })

      // BACK plate: the large plain rounded-rect, nearly the full cube
      // face, facing IN (its winding is flipped). Sits a hair below the
      // face plane. This is the gray backdrop seen through the opposite
      // face's gaps.
      const backOrigin: Vector3 = [
        normal[0] * (HALF - PLATE_SEPARATION),
        normal[1] * (HALF - PLATE_SEPARATION),
        normal[2] * (HALF - PLATE_SEPARATION),
      ]
      const backPositions = fillPlanarContour(
        backOrigin, axisU, axisV,
        roundedRectContour(
          BACK_PANEL_HALF, BACK_PANEL_CORNER_RADIUS, CIRCLE_SEGMENTS,
        ),
        true,
      )
      regions.push({
        id: `back:${normal.join(",")}`,
        kind: "back",
        direction,
        label,
        positions: new Float32Array(backPositions),
        // Faces inward — the negated normal — so lighting/culling see it
        // as the inside surface.
        normal: [-direction[0], -direction[1], -direction[2]],
      })
    }
  }

  // --- 8 corner circles (cube-spec.md §2.2) ---------------------------
  // A flat disc perpendicular to the body diagonal, centred on the
  // diagonal at CORNER_DISTANCE, sized to reach the three adjacent
  // panels. Its in-plane basis is any two vectors spanning the plane
  // whose normal is the diagonal.
  for (const sx of [1, -1] as const) {
    for (const sy of [1, -1] as const) {
      for (const sz of [1, -1] as const) {
        const diagonal = normalise([sx, sy, sz])
        // A stable in-plane basis: cross the diagonal with whichever world
        // axis it is least parallel to, then complete the frame.
        const reference: Vector3 =
          Math.abs(diagonal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
        const axisU = normalise(cross(diagonal, reference))
        const axisV = cross(diagonal, axisU)
        const origin: Vector3 = [
          diagonal[0] * CORNER_DISTANCE,
          diagonal[1] * CORNER_DISTANCE,
          diagonal[2] * CORNER_DISTANCE,
        ]
        const positions = fillPlanarContour(
          origin, axisU, axisV,
          circleContour(CORNER_RADIUS, CIRCLE_SEGMENTS),
        )
        regions.push({
          id: `corner:${sx},${sy},${sz}`,
          kind: "corner",
          direction: diagonal,
          label: labelFor(sx, sy, sz),
          positions: new Float32Array(positions),
          normal: diagonal,
        })
      }
    }
  }

  return regions
}

/**
 * Ray/triangle intersection, Möller–Trumbore.
 *
 * Returns the distance along the ray, or null when it misses. Shared by
 * every part, so picking is one loop over the same triangles that were
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
 * The nearest part a ray hits, or null.
 *
 * Nearest rather than first: the ray passes through the void gaps and can
 * reach a panel on the far side, so the closest hit along the ray is the
 * one under the cursor (cube-spec.md §4).
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
