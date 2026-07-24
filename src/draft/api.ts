// =====================================================================
// src/draft/api.ts — TWO-DIMENSIONAL DRAWING.
//
// What Onshape calls a sketch. (Its "draft" — the moulding taper — is a
// separate feature, outside MVP scope.)
//
// DECLARATIVE, not a chain with an implicit cursor. This is where
// CadQuery's Workplane goes wrong: there, `.vertices().circle(0.5)`
// creates N circles with no loop visible in the code, driven by a stack
// the reader cannot see. Their own docs concede it hurts debugging.
//
// Here every curve is named by the identifier it returns, and fan-out is
// an ordinary `map` in user code — visible.
//
// MVP SCOPE: literal geometry. Constraints are declared in the types
// below, but the solver lands later; `solve: false` takes coordinates as
// written.
// =====================================================================

import type { SketchId, Length, Angle, Scalar, Point2 } from "../common/kernel"
import type {
  Reference, Selector, PlaneReference, Buildable, FaceId, EdgeId, VertexId,
} from "../common/api"

// =====================================================================
// 1. IDENTITY OF DRAWN ENTITIES
// =====================================================================
// Every curve gets a STABLE identifier on creation. Constraints and
// references name the identifier, never an array position — otherwise
// inserting a curve in the middle would silently repoint every
// constraint after it.

declare const brand: unique symbol
export type CurveId = number & { readonly [brand]: "draft-curve" }
export type PointId = number & { readonly [brand]: "draft-point" }

/** Notable points on a curve: a constraint target without needing a
 *  free-standing point. */
export interface CurveAnchor {
  readonly curve: CurveId
  readonly at: "start" | "end" | "center" | "middle"
}

export type ConstraintTarget = PointId | CurveAnchor

// =====================================================================
// 2. DRAWING
// =====================================================================
// Each method returns the builder plus the identifier of what it just
// created, so a later constraint can name it.

export interface DraftStepCurves {
  // --- curves ---------------------------------------------------------
  line(from: Point2, to: Point2): DraftStepCurves & { readonly id: CurveId }
  arc(from: Point2, to: Point2, bulge: Scalar): DraftStepCurves & { readonly id: CurveId }
  arcFromCenter(center: Point2, radius: Length, start: Angle, end: Angle): DraftStepCurves & { readonly id: CurveId }
  circle(center: Point2, radius: Length): DraftStepCurves & { readonly id: CurveId }
  ellipse(center: Point2, radiusX: Length, radiusY: Length, rotation: Angle): DraftStepCurves & { readonly id: CurveId }
  spline(points: readonly Point2[], closed: boolean): DraftStepCurves & { readonly id: CurveId }

  // --- shorthands: several curves at once ------------------------------
  rectangle(center: Point2, width: Length, height: Length): DraftStepCurves
  slot(center: Point2, length: Length, width: Length, angle: Angle): DraftStepCurves
  polygon(center: Point2, radius: Length, sides: number, inscribed: boolean): DraftStepCurves

  /** A free-standing point: useful as a constraint anchor. */
  point(at: Point2): DraftStepCurves & { readonly id: PointId }

  /** Construction geometry: guides the solver, never becomes material. */
  construction(draw: (curves: DraftStepCurves) => void): DraftStepCurves

  // --- reference picking (section 3) -----------------------------------
  project(entity: Selector<FaceId | EdgeId | VertexId>): DraftStepCurves & { readonly id: CurveId }
  intersect(face: Selector<FaceId>): DraftStepCurves & { readonly id: CurveId }
  offsetOf(curve: CurveId, distance: Length): DraftStepCurves & { readonly id: CurveId }
  mirrorOf(curves: readonly CurveId[], about: CurveId): DraftStepCurves

  // --- constraints (section 4) -----------------------------------------
  constrain(constraint: DraftConstraint): DraftStepCurves

  /** Closes the draft. Regions are derived from the closed loops. */
  done(): Buildable<DraftInput, SketchId>
}

// =====================================================================
// 3. REFERENCE PICKING
// =====================================================================
// Brings existing three-dimensional geometry into the draft plane.
//
// The reference stays LIVE: if the body changes, the draft regenerates
// with it. That is why the selector is stored rather than the
// coordinates it currently resolves to.

export type DraftReference =
  /** Projects an edge, face or vertex onto the plane (Onshape: "Use"). */
  | { readonly kind: "project"; readonly entity: Selector<FaceId | EdgeId | VertexId>; readonly id: CurveId }
  /** The curve where a face meets the draft plane. */
  | { readonly kind: "intersect"; readonly face: Selector<FaceId>; readonly id: CurveId }
  /** A parallel offset of an existing curve. */
  | { readonly kind: "offset"; readonly source: CurveId; readonly distance: Length; readonly id: CurveId }
  /** Mirrors curves about a construction line. */
  | { readonly kind: "mirror"; readonly sources: readonly CurveId[]; readonly about: CurveId }

// =====================================================================
// 4. CONSTRAINTS
// =====================================================================
// Solved by a two-dimensional solver: the user draws approximately and
// constraints pin down the intent. This is what separates parametric
// CAD from vector drawing.
//
// Declared now, solved later — the MVP runs with `solve: false`.

export type DraftConstraint =
  // --- geometric (no value) -------------------------------------------
  | { readonly kind: "coincident"; readonly first: ConstraintTarget; readonly second: ConstraintTarget }
  | { readonly kind: "horizontal"; readonly curve: CurveId }
  | { readonly kind: "vertical"; readonly curve: CurveId }
  | { readonly kind: "parallel"; readonly first: CurveId; readonly second: CurveId }
  | { readonly kind: "perpendicular"; readonly first: CurveId; readonly second: CurveId }
  | { readonly kind: "tangent"; readonly first: CurveId; readonly second: CurveId }
  | { readonly kind: "concentric"; readonly first: CurveId; readonly second: CurveId }
  | { readonly kind: "equal"; readonly first: CurveId; readonly second: CurveId }
  | { readonly kind: "collinear"; readonly first: CurveId; readonly second: CurveId }
  | { readonly kind: "midpoint"; readonly point: ConstraintTarget; readonly curve: CurveId }
  | { readonly kind: "symmetric"; readonly first: ConstraintTarget; readonly second: ConstraintTarget; readonly about: CurveId }
  | { readonly kind: "fixed"; readonly target: ConstraintTarget }
  // --- dimensional (carries an expression) -----------------------------
  | { readonly kind: "distance"; readonly first: ConstraintTarget; readonly second: ConstraintTarget; readonly value: Length }
  | { readonly kind: "horizontal-distance"; readonly first: ConstraintTarget; readonly second: ConstraintTarget; readonly value: Length }
  | { readonly kind: "vertical-distance"; readonly first: ConstraintTarget; readonly second: ConstraintTarget; readonly value: Length }
  | { readonly kind: "angle"; readonly first: CurveId; readonly second: CurveId; readonly value: Angle }
  | { readonly kind: "radius"; readonly curve: CurveId; readonly value: Length }
  | { readonly kind: "diameter"; readonly curve: CurveId; readonly value: Length }
  | { readonly kind: "length"; readonly curve: CurveId; readonly value: Length }

// Dimensional values are Length and Angle — that is, EXPRESSIONS. So
//
//   constrain({ kind: "radius", curve, value: millimeters`${outerDiameter} / 2` })
//
// keeps the relationship alive: changing outerDiameter redraws the
// sketch, rather than leaving a stale number behind.

/** Solver report. Never fails silently. */
export interface DraftSolveResult {
  readonly status: "well-constrained" | "under-constrained" | "over-constrained" | "inconsistent"
  /** Remaining degrees of freedom. */
  readonly freedom: number
  /** For over-constrained or inconsistent: which constraints clash. */
  readonly conflicting: readonly number[]
  /** For under-constrained: what can still move. */
  readonly unconstrained: readonly ConstraintTarget[]
}

// =====================================================================
// 5. PERSISTED INPUT
// =====================================================================

export interface DraftInput {
  readonly plane: PlaneReference
  readonly curves: readonly DraftCurve[]
  readonly references: readonly DraftReference[]
  readonly constraints: readonly DraftConstraint[]
  /** False means literal geometry, as in vector drawing: the MVP
   *  default until the solver lands. */
  readonly solve: boolean
}

export interface DraftCurve {
  readonly id: CurveId
  readonly construction: boolean
  readonly geometry: DraftGeometry
}

export type DraftGeometry =
  | { readonly kind: "line"; readonly from: Point2; readonly to: Point2 }
  | { readonly kind: "arc"; readonly from: Point2; readonly to: Point2; readonly bulge: Scalar }
  | { readonly kind: "arc-from-center"; readonly center: Point2; readonly radius: Length; readonly start: Angle; readonly end: Angle }
  | { readonly kind: "circle"; readonly center: Point2; readonly radius: Length }
  | { readonly kind: "ellipse"; readonly center: Point2; readonly radiusX: Length; readonly radiusY: Length; readonly rotation: Angle }
  | { readonly kind: "spline"; readonly points: readonly Point2[]; readonly closed: boolean }
  | { readonly kind: "point"; readonly at: Point2 }

// =====================================================================
// 6. REGIONS
// =====================================================================
// A draft yields N closed regions. Generating features consume one or
// all of them, chosen by selector rather than by index — index breaks as
// soon as the drawing changes, for the same reason it does in three
// dimensions.

export interface DraftRegion {
  readonly draft: Reference<SketchId>
  readonly outer: readonly CurveId[]
  readonly inner: readonly (readonly CurveId[])[] // holes
}

export type RegionsOf = (draft: Reference<SketchId>) => Selector<never>
export type RegionContaining = (draft: Reference<SketchId>, point: Point2) => Selector<never>
export type LargestRegion = (draft: Reference<SketchId>) => Selector<never>

export declare const regionsOf: RegionsOf
export declare const regionContaining: RegionContaining
export declare const largestRegion: LargestRegion

/** The entry point placed on the `cad` facade. */
export type DraftApi = (plane: PlaneReference) => DraftStepCurves
