// =====================================================================
// src/draft/kernel.ts
//
// What the KERNEL must provide for two-dimensional drawing.
// =====================================================================

import type { SketchId, Vector2, CapabilityId } from "../common/kernel"

/** If one is missing the feature does not load — a named failure at
 *  startup rather than halfway through a user's model. */
export const DRAFT_CAPABILITIES = [
  "sketch.region",
  "sketch.offset-2d",
  "query.topology",
] as const satisfies readonly CapabilityId[]

/** Topological roles produced, in DETERMINISTIC order: the same input
 *  yields the same indices across regenerations. */
export const DRAFT_ROLES = ["region", "curve"] as const
export type DraftRole = (typeof DRAFT_ROLES)[number]

/**
 * Capability input, with expressions ALREADY resolved to numbers.
 *
 * Curves travel as one flat packed buffer rather than an array of
 * objects: zero-copy from the Float64Array, and one boundary crossing
 * instead of one per curve.
 */
export interface DraftKernelInput {
  readonly curves: readonly DraftKernelCurve[]
  /** Plane basis, resolved to world coordinates. */
  readonly origin: Vector3Tuple
  readonly normal: Vector3Tuple
  readonly xDirection: Vector3Tuple
}

type Vector3Tuple = readonly [number, number, number]

export type DraftKernelCurve =
  | { readonly kind: "line"; readonly from: Vector2; readonly to: Vector2 }
  | { readonly kind: "arc"; readonly from: Vector2; readonly to: Vector2; readonly bulge: number }
  | { readonly kind: "circle"; readonly center: Vector2; readonly radius: number }
  | { readonly kind: "ellipse"; readonly center: Vector2; readonly radiusX: number; readonly radiusY: number; readonly rotation: number }
  | { readonly kind: "spline"; readonly points: readonly Vector2[]; readonly closed: boolean }

export interface DraftKernelOutput {
  readonly sketch: SketchId
  /**
   * Closed regions found, outermost first. A profile with a hole yields
   * ONE region carrying one inner loop — not two regions. Getting this
   * wrong would make an extrude of a washer produce a disc.
   */
  readonly regions: readonly {
    readonly outer: readonly number[]
    readonly inner: readonly (readonly number[])[]
  }[]
}
