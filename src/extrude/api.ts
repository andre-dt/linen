// =====================================================================
// src/extrude/api.ts
//
// What the USER writes: steps plus the persisted input.
// No UI, no execution, no kernel.
// =====================================================================

import type { BodyId, SketchId, FaceId, Vector3, Length, Angle } from "../common/kernel"
import type {
  Reference, Selector, CombineStep, CombineOperation, Buildable,
} from "../common/api"

// --- steps -------------------------------------------------------------
// Each step exposes ONLY what is relevant at that point, so skipping a
// step is a compile error.
//
// Compare with a flat input object: `direction?`, `symmetric?`,
// `taper?`, `operation?` — four optionals that are really conditionals,
// where the compiler can neither require them when they matter nor
// reject them when they do not.

export interface ExtrudeStepExtent {
  distance(value: Length): ExtrudeStepOptions
  symmetric(total: Length): ExtrudeStepOptions
  twoSided(forward: Length, backward: Length): ExtrudeStepCombine
  upToFace(face: Selector<FaceId>): ExtrudeStepUpToFace
  through(): ExtrudeStepCombine
  /** An explicit direction instead of the draft normal. */
  along(direction: Vector3): ExtrudeStepExtent
}

export interface ExtrudeStepOptions extends ExtrudeStepCombine {
  /** Taper angle. Absent from upToFace, where it would be ambiguous. */
  taper(angle: Angle): ExtrudeStepCombine
}

export interface ExtrudeStepUpToFace extends ExtrudeStepCombine {
  offset(value: Length): ExtrudeStepCombine
}

export interface ExtrudeStepCombine
  extends CombineStep<Buildable<ExtrudeInput, BodyId>> {}

// --- persisted input ---------------------------------------------------
// Explicit `| null`, never `?`: it forces a decision at deserialization
// instead of letting a field quietly go missing on a round trip.

export interface ExtrudeInput {
  readonly profile: Reference<SketchId>
  readonly direction: Vector3 | null // null means the draft normal
  readonly extent: ExtrudeExtent
  readonly combine: CombineOperation
}

export type ExtrudeExtent =
  | { readonly kind: "distance"; readonly value: Length; readonly taper: Angle | null }
  | { readonly kind: "symmetric"; readonly total: Length; readonly taper: Angle | null }
  | { readonly kind: "two-sided"; readonly forward: Length; readonly backward: Length }
  | { readonly kind: "up-to-face"; readonly face: Selector<FaceId>; readonly offset: Length | null }
  | { readonly kind: "through" }

/** The entry point placed on the `cad` facade. */
export type ExtrudeApi = (profile: Reference<SketchId>) => ExtrudeStepExtent
