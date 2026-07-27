// =====================================================================
// packages/viewer/sketch.ts — DRAWING ON A PLANE.
//
// The geometry the user draws with the mouse, rendered as lines in 3D on
// the sketch plane. This is the Onshape drawing experience: pick a tool,
// click points on the plane, see the curve appear under the cursor.
//
// TWO DIMENSIONS IN, THREE OUT
// ----------------------------
// Everything the user draws is two-dimensional — a sketch lives ON its
// plane, and that is what gets persisted. This module owns the one
// conversion: (u, v) on the plane <-> (x, y, z) in the world. Nothing
// above it deals in world coordinates, and nothing below it deals in
// sketch coordinates.
//
// Keeping that conversion in ONE place is what lets the sketch survive
// its plane changing: re-project the same (u, v) through a new frame and
// the drawing moves with it, rather than being stranded at stale world
// positions.
//
// CURVES ARE TESSELLATED HERE, NOT ON THE SERVER
// ----------------------------------------------
// A circle being dragged out re-tessellates every frame. Round-tripping
// that to the kernel would make the rubber band lag the cursor by a
// network hop, and the result is thrown away the moment the user clicks
// anyway. The kernel still owns the REAL geometry — this is a preview of
// what is about to be committed, drawn at screen precision.
// =====================================================================

import type { Vector3 } from "@linen/cad/kernel"
import type { DatumPlane } from "./planes"

// =====================================================================
// 1. SKETCH COORDINATES
// =====================================================================

/** A point on the sketch plane. Millimetres, like everything else. */
export interface Point2 {
  readonly u: number
  readonly v: number
}

/**
 * The plane a sketch is drawn on, as a frame: an origin plus two in-plane
 * axes. Derived from a datum plane, but kept separate — a sketch on a
 * planar FACE has the same shape with a different origin, so the drawing
 * code never needs to know which it got.
 */
export interface SketchFrame {
  readonly origin: Vector3
  readonly right: Vector3
  readonly up: Vector3
  readonly normal: Vector3
}

export const frameOfDatum = (plane: DatumPlane, offset = 0): SketchFrame => ({
  origin: [
    plane.normal[0] * offset,
    plane.normal[1] * offset,
    plane.normal[2] * offset,
  ],
  right: plane.right,
  up: plane.up,
  normal: plane.normal,
})

/** Sketch coordinates -> world. The only place this happens. */
export const toWorld = (frame: SketchFrame, point: Point2): Vector3 => [
  frame.origin[0] + frame.right[0] * point.u + frame.up[0] * point.v,
  frame.origin[1] + frame.right[1] * point.u + frame.up[1] * point.v,
  frame.origin[2] + frame.right[2] * point.u + frame.up[2] * point.v,
]

/** World -> sketch coordinates, for a point already known to be on the
 *  plane. Projection, so a point slightly off-plane lands at its nearest
 *  in-plane position rather than being rejected. */
export const toSketch = (frame: SketchFrame, world: Vector3): Point2 => {
  const dx = world[0] - frame.origin[0]
  const dy = world[1] - frame.origin[1]
  const dz = world[2] - frame.origin[2]
  return {
    u: dx * frame.right[0] + dy * frame.right[1] + dz * frame.right[2],
    v: dx * frame.up[0] + dy * frame.up[1] + dz * frame.up[2],
  }
}

/**
 * Where a ray meets the sketch plane, in sketch coordinates.
 *
 * This is what turns a mouse position into a point the user drew. Unlike
 * the datum-plane pick, it is TWO-SIDED: once you are drawing on a
 * plane, orbiting behind it must not make your own sketch unclickable.
 *
 * Returns null only when the ray is parallel to the plane — at which
 * point the plane is edge-on and there is nothing to click anyway.
 */
export const rayToSketch = (
  frame: SketchFrame,
  origin: Vector3,
  direction: Vector3,
): Point2 | null => {
  const facing =
    direction[0] * frame.normal[0] +
    direction[1] * frame.normal[1] +
    direction[2] * frame.normal[2]
  if (Math.abs(facing) < 1e-9) return null

  const toOrigin: Vector3 = [
    frame.origin[0] - origin[0],
    frame.origin[1] - origin[1],
    frame.origin[2] - origin[2],
  ]
  const distance =
    (toOrigin[0] * frame.normal[0] +
      toOrigin[1] * frame.normal[1] +
      toOrigin[2] * frame.normal[2]) /
    facing
  // Behind the camera: the user is looking away from the plane.
  if (distance <= 0) return null

  return toSketch(frame, [
    origin[0] + direction[0] * distance,
    origin[1] + direction[1] * distance,
    origin[2] + direction[2] * distance,
  ])
}

// =====================================================================
// 2. WHAT CAN BE DRAWN
// =====================================================================
// Mirrors DraftGeometry in cad/draft/api.ts, but in evaluated numbers
// rather than expressions: this is the preview, and a preview cannot
// wait for an expression engine. The persisted form keeps the formulas.

export type SketchCurve =
  | { readonly kind: "line"; readonly from: Point2; readonly to: Point2 }
  | { readonly kind: "rectangle"; readonly from: Point2; readonly to: Point2 }
  | { readonly kind: "circle"; readonly center: Point2; readonly radius: number }
  | { readonly kind: "arc"; readonly from: Point2; readonly to: Point2; readonly through: Point2 }
  | { readonly kind: "spline"; readonly points: readonly Point2[]; readonly closed: boolean }
  | { readonly kind: "polygon"; readonly center: Point2; readonly radius: number; readonly sides: number }
  | { readonly kind: "point"; readonly at: Point2 }

/** How finely a curve is broken into segments. Fixed rather than
 *  adaptive: at sketch scale the difference is invisible, and an
 *  adaptive count would make the vertex buffer resize while dragging. */
const CIRCLE_SEGMENTS = 64
const ARC_SEGMENTS = 48

/**
 * Breaks a curve into the line segments that draw it: pairs of points,
 * ready for gl.LINES.
 *
 * Returns SKETCH coordinates. Projection to world happens once, at
 * upload, so a plane change re-projects rather than re-tessellates.
 */
export const tessellate = (curve: SketchCurve): readonly Point2[] => {
  switch (curve.kind) {
    case "line":
      return [curve.from, curve.to]

    case "rectangle": {
      const { from, to } = curve
      const a = from
      const b = { u: to.u, v: from.v }
      const c = to
      const d = { u: from.u, v: to.v }
      return [a, b, b, c, c, d, d, a]
    }

    case "circle":
      return closedLoop(
        Array.from({ length: CIRCLE_SEGMENTS }, (_, index) => {
          const angle = (index / CIRCLE_SEGMENTS) * Math.PI * 2
          return {
            u: curve.center.u + Math.cos(angle) * curve.radius,
            v: curve.center.v + Math.sin(angle) * curve.radius,
          }
        }),
      )

    case "polygon":
      return closedLoop(
        Array.from({ length: Math.max(3, curve.sides) }, (_, index) => {
          // Starting at +v (straight up) rather than +u: a hexagon with
          // a flat bottom is what people expect to see.
          const angle = (index / Math.max(3, curve.sides)) * Math.PI * 2 + Math.PI / 2
          return {
            u: curve.center.u + Math.cos(angle) * curve.radius,
            v: curve.center.v + Math.sin(angle) * curve.radius,
          }
        }),
      )

    case "arc":
      return openStrip(arcPoints(curve.from, curve.through, curve.to))

    case "spline":
      // Straight chords through the control points. A real spline is the
      // solver's business; this reads the shape while drawing.
      return curve.closed
        ? closedLoop(curve.points)
        : openStrip(curve.points)

    case "point":
      // A small cross, so a bare point is visible at all.
      return crossAt(curve.at, 1.2)
  }
}

/** Consecutive points as segments, then last back to first. */
const closedLoop = (points: readonly Point2[]): readonly Point2[] => {
  const out: Point2[] = []
  for (let index = 0; index < points.length; index++) {
    out.push(points[index]!, points[(index + 1) % points.length]!)
  }
  return out
}

/** Consecutive points as segments, not closed. */
const openStrip = (points: readonly Point2[]): readonly Point2[] => {
  const out: Point2[] = []
  for (let index = 0; index + 1 < points.length; index++) {
    out.push(points[index]!, points[index + 1]!)
  }
  return out
}

const crossAt = (at: Point2, size: number): readonly Point2[] => [
  { u: at.u - size, v: at.v }, { u: at.u + size, v: at.v },
  { u: at.u, v: at.v - size }, { u: at.u, v: at.v + size },
]

/**
 * Three-point arc: start, a point it passes through, end.
 *
 * The centre is the circumcentre of the three. Collinear points have
 * none — the denominator goes to zero — and that is a straight line, so
 * it degrades to one rather than producing NaN coordinates that would
 * silently corrupt the buffer.
 */
const arcPoints = (
  from: Point2,
  through: Point2,
  to: Point2,
): readonly Point2[] => {
  const denominator =
    2 * (from.u * (through.v - to.v) +
         through.u * (to.v - from.v) +
         to.u * (from.v - through.v))
  if (Math.abs(denominator) < 1e-9) return [from, to]

  const fromSquared = from.u * from.u + from.v * from.v
  const throughSquared = through.u * through.u + through.v * through.v
  const toSquared = to.u * to.u + to.v * to.v

  const center: Point2 = {
    u: (fromSquared * (through.v - to.v) +
        throughSquared * (to.v - from.v) +
        toSquared * (from.v - through.v)) / denominator,
    v: (fromSquared * (to.u - through.u) +
        throughSquared * (from.u - to.u) +
        toSquared * (through.u - from.u)) / denominator,
  }

  const radius = Math.hypot(from.u - center.u, from.v - center.v)
  const angleOf = (point: Point2): number =>
    Math.atan2(point.v - center.v, point.u - center.u)

  const start = angleOf(from)
  const end = angleOf(to)
  const middle = angleOf(through)

  // Sweep the way that actually passes through the middle point —
  // otherwise the arc takes the long way round and looks inverted.
  let sweep = end - start
  while (sweep <= -Math.PI) sweep += Math.PI * 2
  while (sweep > Math.PI) sweep -= Math.PI * 2

  let toMiddle = middle - start
  while (toMiddle <= -Math.PI) toMiddle += Math.PI * 2
  while (toMiddle > Math.PI) toMiddle -= Math.PI * 2

  // The middle is not on the short sweep, so go the other way.
  if (sweep >= 0 !== toMiddle >= 0 || Math.abs(toMiddle) > Math.abs(sweep)) {
    sweep = sweep >= 0 ? sweep - Math.PI * 2 : sweep + Math.PI * 2
  }

  return Array.from({ length: ARC_SEGMENTS + 1 }, (_, index) => {
    const angle = start + (sweep * index) / ARC_SEGMENTS
    return {
      u: center.u + Math.cos(angle) * radius,
      v: center.v + Math.sin(angle) * radius,
    }
  })
}

// =====================================================================
// 3. SNAPPING
// =====================================================================
// What makes drawing feel precise without demanding precision. Onshape
// snaps to existing geometry and to the axes; so do we.
//
// Snapping is a VIEW concern only — it adjusts the point before it is
// recorded, and what gets recorded is the snapped value. It never
// creates a constraint here; the solver does that later, from the same
// evidence.

export interface SnapResult {
  readonly point: Point2
  /** What it snapped to, for the cursor badge. Null when it did not. */
  readonly kind: "endpoint" | "center" | "axis" | "grid" | null
}

/**
 * Snaps a raw cursor position.
 *
 * Order is by strength: an existing endpoint beats an axis, which beats
 * the grid. `tolerance` is in sketch millimetres and should be derived
 * from the zoom level — a fixed tolerance would be unusably sticky when
 * zoomed out and useless when zoomed in.
 */
export const snap = (
  raw: Point2,
  curves: readonly SketchCurve[],
  tolerance: number,
  gridStep = 5,
): SnapResult => {
  // --- existing geometry ---
  // A plain loop rather than a closure: assigning `best` from inside one
  // defeats TypeScript's narrowing, and the check below then reads it as
  // `never`.
  let best: { point: Point2; kind: SnapResult["kind"]; distance: number } | null = null
  for (const curve of curves) {
    for (const anchor of anchorsOf(curve)) {
      const distance = Math.hypot(anchor.at.u - raw.u, anchor.at.v - raw.v)
      if (distance > tolerance) continue
      if (best !== null && distance >= best.distance) continue
      best = { point: anchor.at, kind: anchor.kind, distance }
    }
  }
  if (best !== null) return { point: best.point, kind: best.kind }

  // --- the axes ---
  // Snapping to u=0 and v=0 independently, so a point can be on one axis
  // without being dragged to the origin.
  const onU = Math.abs(raw.u) <= tolerance
  const onV = Math.abs(raw.v) <= tolerance
  if (onU || onV) {
    return {
      point: { u: onU ? 0 : raw.u, v: onV ? 0 : raw.v },
      kind: "axis",
    }
  }

  // --- the grid ---
  const snapped = {
    u: Math.round(raw.u / gridStep) * gridStep,
    v: Math.round(raw.v / gridStep) * gridStep,
  }
  if (Math.hypot(snapped.u - raw.u, snapped.v - raw.v) <= tolerance) {
    return { point: snapped, kind: "grid" }
  }

  return { point: raw, kind: null }
}

/** The points on a curve worth snapping to. */
const anchorsOf = (
  curve: SketchCurve,
): readonly { at: Point2; kind: SnapResult["kind"] }[] => {
  switch (curve.kind) {
    case "line":
      return [{ at: curve.from, kind: "endpoint" }, { at: curve.to, kind: "endpoint" }]
    case "rectangle": {
      const { from, to } = curve
      return [
        { at: from, kind: "endpoint" },
        { at: { u: to.u, v: from.v }, kind: "endpoint" },
        { at: to, kind: "endpoint" },
        { at: { u: from.u, v: to.v }, kind: "endpoint" },
      ]
    }
    case "circle":
    case "polygon":
      return [{ at: curve.center, kind: "center" }]
    case "arc":
      return [{ at: curve.from, kind: "endpoint" }, { at: curve.to, kind: "endpoint" }]
    case "spline":
      return curve.points.map((at) => ({ at, kind: "endpoint" as const }))
    case "point":
      return [{ at: curve.at, kind: "endpoint" }]
  }
}

// =====================================================================
// 4. BUFFER
// =====================================================================

/**
 * Projects tessellated curves into a world-space line buffer, ready for
 * gl.LINES. One buffer for the whole sketch: a draw call per curve would
 * put a hundred calls in the frame for a sketch of any size.
 */
export const sketchBuffer = (
  frame: SketchFrame,
  curves: readonly SketchCurve[],
): Float32Array => {
  const segments: Point2[] = []
  for (const curve of curves) segments.push(...tessellate(curve))

  const out = new Float32Array(segments.length * 3)
  for (let index = 0; index < segments.length; index++) {
    const world = toWorld(frame, segments[index]!)
    out[index * 3] = world[0]
    out[index * 3 + 1] = world[1]
    out[index * 3 + 2] = world[2]
  }
  return out
}
