// =====================================================================
// src/extrude/kernel.ts
//
// What the KERNEL must provide for this feature to exist.
// The OCCT/Parasolid common denominator, declared next to its user
// rather than in a central list nobody maintains.
// =====================================================================

import type { BodyId, SketchId, Vector3, CapabilityId } from "../common/kernel"

/** If one is missing the feature does not load — a named failure at
 *  startup rather than halfway through a user's model. */
export const EXTRUDE_CAPABILITIES = [
  "solid.extrude",
  "boolean.union",
  "boolean.subtract",
  "boolean.intersect",
] as const satisfies readonly CapabilityId[]

/**
 * Topological roles produced, in DETERMINISTIC order: the same input
 * yields the same indices, every time.
 *
 * Without that guarantee `created(reference, "side")` would point at
 * different faces across regenerations — which is precisely how
 * CadQuery's `>Z[-2]` silently selects the wrong face after a parameter
 * change, producing a solid that is valid and wrong.
 */
export const EXTRUDE_ROLES = ["start", "end", "side"] as const
export type ExtrudeRole = (typeof EXTRUDE_ROLES)[number]

/** Capability input, with expressions ALREADY resolved to numbers. The
 *  N-API boundary only ever sees numbers. */
export interface ExtrudeKernelInput {
  readonly profile: SketchId
  readonly direction: Vector3 | null // null means the sketch normal
  readonly forward: number
  readonly backward: number
  readonly taper: number
  readonly upToFace: { readonly face: number; readonly offset: number } | null
}

export interface ExtrudeKernelOutput {
  readonly body: BodyId
  /** Faces by role, in the deterministic order declared above. */
  readonly faces: Readonly<Record<ExtrudeRole, readonly number[]>>
}
