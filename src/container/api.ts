// =====================================================================
// src/container/api.ts — DEPENDENCY INJECTION.
//
// TWO MECHANISMS, TWO PROBLEMS:
//
//   import type   TYPE cycles. Erased at compile time, so it does not
//                 exist at runtime. This is why common/api.ts can import
//                 step types from every feature while every feature
//                 imports from common — no runtime cycle results.
//
//   this file     VALUE cycles. When one feature CALLS another at
//                 runtime, a direct `import { otherFeature }` would
//                 bring the cycle back. Solved by lazy proxy: the
//                 reference exists immediately, resolution happens on
//                 first use.
//
// No feature in the MVP calls another, but the mechanism is in place so
// that adding one later is a new file rather than a refactor.
// =====================================================================

import type { KernelAdapter, KernelSession, CapabilityId } from "../common/kernel"
import type { Cad, FeatureName, VariableScope } from "../common/api"
import type { FeatureApi, CommandDefinition } from "../common/feature"

// =====================================================================
// 1. REGISTRATION
// =====================================================================

export interface ContainerOptions {
  readonly adapter: KernelAdapter
  readonly features: readonly FeatureSource[]
  readonly variables: VariableScope
}

/** An eager feature, or a loader for one heavy enough to defer. */
export type FeatureSource =
  | FeatureApi
  | { readonly name: FeatureName; readonly load: () => Promise<{ default: FeatureApi }> }

export interface Container {
  /**
   * Resolves deferred imports. Call before touching `cad`.
   *
   * This exists so that `cad.extrude()` stays synchronous. Making the
   * facade async to accommodate lazy loading would push a promise into
   * every call site in the language.
   */
  prepare(names?: readonly FeatureName[]): Promise<void>
  readonly cad: Cad
  readonly session: KernelSession
  /** Every command from every registered feature, for the toolbar. */
  readonly commands: readonly CommandDefinition<never, never>[]
  dispose(): Promise<void>
}

export type CreateContainer = (options: ContainerOptions) => Container
export declare const createContainer: CreateContainer

// =====================================================================
// 2. HOW THE PROXY BREAKS CYCLES
// =====================================================================
// `cad` is a Proxy whose `get` resolves a feature on first access and
// caches it.
//
// When a feature's `create(context)` runs it merely CAPTURES
// `context.cad`. Only when the returned builder actually executes does
// `context.cad.hole` trip the proxy and resolve hole — by which point
// the calling feature has finished creating. The cycle lives in the USE
// graph and never in the CONSTRUCTION graph.
//
// The container tells the two apart:
//
//   USE cycle          bolt calls hole calls bolt    legitimate, works
//   CREATION cycle     create() calls create()       a real bug
//
// The second is reported with the full path, because it is always a
// mistake: `create` must capture the context and nothing more.

export class CreationCycleError extends Error {
  constructor(readonly path: readonly string[]) {
    super(
      `creation cycle: ${path.join(" -> ")}\n` +
        `create() must not call context.cad.* — it should only capture ` +
        `the context. Move the call into the builder or into execute().`,
    )
    this.name = "CreationCycleError"
  }
}

export class DuplicateFeatureError extends Error {
  constructor(readonly feature: string) {
    super(`duplicate feature: ${feature}`)
    this.name = "DuplicateFeatureError"
  }
}

export class UnknownFeatureError extends Error {
  constructor(readonly feature: string) {
    super(`unknown feature: ${feature}`)
    this.name = "UnknownFeatureError"
  }
}

export class FeatureNotLoadedError extends Error {
  constructor(readonly feature: string) {
    super(`feature "${feature}" is deferred and was never loaded — call prepare() first`)
    this.name = "FeatureNotLoadedError"
  }
}

/**
 * Thrown at STARTUP, naming every gap at once, rather than failing
 * halfway through a user's model.
 *
 * This is what makes "OCCT today, Parasolid tomorrow" honest: a feature
 * needing something the connected kernel lacks simply does not load,
 * instead of breaking mid-command.
 */
export class MissingCapabilityError extends Error {
  constructor(
    readonly missing: readonly { readonly feature: string; readonly capability: CapabilityId }[],
    readonly kernel: string,
  ) {
    super(
      `kernel "${kernel}" does not support:\n` +
        missing.map((entry) => `  ${entry.feature} requires ${entry.capability}`).join("\n"),
    )
    this.name = "MissingCapabilityError"
  }
}

// =====================================================================
// 3. TRADE-OFFS
// =====================================================================
//
// GAINED: arbitrary cycles without manual ordering; genuine lazy loading
// per feature; third-party and user-defined features taking exactly the
// same path as built-ins, with no privileged route.
//
// LOST: tree-shaking of the facade. `cad` is a Proxy, so a bundler
// cannot prove which features go unused. Mitigated by keeping heavy
// features out of the initial bundle through `load`, and by each
// src/<feature>/ remaining importable directly for anyone who wants the
// static path.
//
// The proxy costs one `get` per call. Against a kernel operation
// measured in milliseconds that is noise, and resolution is cached after
// the first hit.
