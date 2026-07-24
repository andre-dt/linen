// =====================================================================
// src/features.ts — implementation barrel and registry.
//
// The only file that imports feature VALUES. No feature imports this
// one, so the value graph is a star rather than a cycle:
//
//        common/  (root — imports no feature at all)
//            ^
//            |  (every feature imports it)
//      draft   extrude
//            ^
//            |  (imports every feature)
//        features.ts
//
// USE cycles — one feature calling another at runtime — live in the
// container, resolved by lazy proxy. None exist in the MVP, but the
// mechanism is already in place so that adding one is a new file rather
// than a refactor.
// =====================================================================

export * from "./common/feature"
export * from "./draft/feature"
export * from "./extrude/feature"

import { draftFeature } from "./draft/feature"
import { extrudeFeature } from "./extrude/feature"

import type { FeatureApi } from "./common/feature"

/** Default preset. Order is irrelevant: the container resolves on demand. */
export const standardPreset: readonly FeatureApi[] = [draftFeature, extrudeFeature]
