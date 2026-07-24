// =====================================================================
// src/kernel.ts — kernel abstraction barrel.
//
// The OCCT/Parasolid common denominator. Each feature declares the
// capabilities it needs in src/<feature>/kernel.ts; they come together
// here. No UI, no steps.
// =====================================================================

export * from "./common/kernel"
export * from "./draft/kernel"
export * from "./extrude/kernel"
