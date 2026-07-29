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

/** Radius the front plate's four corners are rounded by. Larger = rounder
 *  corners on the labelled front plate. */
export const PANEL_CORNER_RADIUS = 0.22

/** Gap left between the FRONT plate's corner and the corner disc, so the
 *  two do not touch (cube-spec.md §2.1, Onshape-like). The disc stays put;
 *  the front plate's drawn size is pulled in by this margin. Per face
 *  axis. */
export const PANEL_DISC_GAP = 0.09

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

/**
 * Half-width of the BACK plate, DERIVED so its rounded corners reach the
 * corner discs' FAR rim — the disc edge toward the cube corner, covering
 * the whole disc width (cube-spec.md §2.1).
 *
 * On a plate plane (e.g. +X at x=HALF) the plate's diagonal is the
 * direction (0,1,1)/√2 in-plane; a point's coordinate along it is
 * (y+z)/√2. The disc centre sits at CORNER_DISTANCE/√3 on each axis, so on
 * the plate diagonal it is at 2·(CORNER_DISTANCE/√3)/√2. The disc's far
 * rim adds CORNER_RADIUS along that same in-plane diagonal (the rim point
 * furthest toward the cube corner). The back plate's own diagonal corner
 * tip is BACK_PANEL_HALF·√2 + BACK_PANEL_CORNER_RADIUS along that
 * diagonal, so solve for BACK_PANEL_HALF to land the tip on the far rim.
 */
export const BACK_PANEL_HALF = (() => {
  // Work in the plate's per-axis coordinate (y = z on the plate diagonal).
  // The plate's rounded-corner tip should land on the disc CENTRE line: the
  // far rim overshot and the near rim tucked in too far, so the corner tip
  // reaches the disc's middle. The disc centre is at CORNER_DISTANCE/√3 per
  // axis; the plate tip is BACK_PANEL_HALF + BACK_PANEL_CORNER_RADIUS/√2.
  const discCentrePerAxis = CORNER_DISTANCE / Math.sqrt(3)
  return discCentrePerAxis - BACK_PANEL_CORNER_RADIUS / Math.SQRT2
})()

/** Half-width of the FRONT plate as DRAWN — pulled in from PANEL_HALF by
 *  PANEL_DISC_GAP so the labelled plate does not touch the discs. The disc
 *  placement above stays anchored to PANEL_HALF, so only the visible front
 *  plate backs off, opening the gap (cube-spec.md §2.1). */
export const FRONT_PANEL_HALF = PANEL_HALF - PANEL_DISC_GAP

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
      // The drawn front plate is pulled in by the disc gap so it never
      // touches the discs.
      const frontPositions = fillPlanarContour(
        frontOrigin, axisU, axisV,
        roundedRectContour(
          FRONT_PANEL_HALF, PANEL_CORNER_RADIUS, CIRCLE_SEGMENTS,
        ),
      )
      regions.push({
        id: `face:${normal.join(",")}`,
        kind: "face",
        direction,
        label,
        positions: new Float32Array(frontPositions),
        normal: direction,
      })

      // BACK plate: the MERGED silhouette — the back rounded-rect UNION the
      // four corner discs, all filled as one solid (cube-spec.md §2.1).
      // Overlapping fills are fine; it reads as one continuous solid that
      // bulges out at each disc. Facing IN (winding flipped), a hair below
      // the face plane.
      const backOrigin: Vector3 = [
        normal[0] * (HALF - PLATE_SEPARATION),
        normal[1] * (HALF - PLATE_SEPARATION),
        normal[2] * (HALF - PLATE_SEPARATION),
      ]
      const backPositions: number[] = fillPlanarContour(
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
 * reach a part on the far side, so the closest hit along the ray is the
 * one under the cursor (cube-spec.md §4).
 *
 * BACK FACES ARE NOT PICKABLE (cube-spec.md §4.5). Every part is
 * single-sided: a ray that strikes a part from behind — its direction
 * agreeing with the part's outward normal (dot >= 0) — is ignored, so it
 * passes through to whatever is beyond. This is what makes a far corner
 * disc, and the open gaps of a front plate, click-through. The back plates
 * carry an inward-pointing normal precisely so a ray reaching them through
 * the opposite face's gap counts as hitting their front.
 */
export const pickCube = (
  regions: readonly CubeRegion[],
  origin: Vector3,
  direction: Vector3,
): CubeRegion | null => {
  let nearest: CubeRegion | null = null
  let nearestDistance = Infinity

  for (const region of regions) {
    // Skip a part the ray meets from behind: if the ray travels the same
    // way the part faces, it can only strike its back.
    const facing =
      direction[0] * region.normal[0] +
      direction[1] * region.normal[1] +
      direction[2] * region.normal[2]
    if (facing >= 0) continue

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
