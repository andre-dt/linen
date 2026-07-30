// =====================================================================
// packages/viewer/renderer-config.ts — WHICH RENDERER BACKEND TO USE.
//
// The single place the backend preference is decided, so switching between
// WebGPU and WebGL2 is one value, not a code change scattered across call
// sites. Resolution order, most specific first:
//
//   1. ?renderer=webgpu|webgl2|auto   — a URL query override (per-load,
//      handy for testing either backend without touching config).
//   2. VITE_RENDERER build/env value  — the project default.
//   3. DEFAULT_RENDERER               — the hard default below.
//
// Keep it a plain resolver returning a RendererPreference; the selector in
// renderer.ts turns that into an actual backend.
// =====================================================================

import {
  createRenderer, hasWebGpu, type Renderer, type RendererPreference,
} from "./renderer"
import { createWebGpuRenderer } from "./gpu-renderer"
import { createWebGl2Renderer } from "./gl-renderer"
import { createBackend, type WebGpuBackend } from "./backend"
import { createCubeScene, type CubeScene } from "./cube-scene"
import { createCubeSceneGpu } from "./cube-scene-gpu"

/** The default when nothing overrides it. 'auto' = WebGPU if the browser
 *  has it, else WebGL2 — the safe, works-everywhere choice. Change this one
 *  value to make the whole app prefer a specific backend. */
export const DEFAULT_RENDERER: RendererPreference = "auto"

const parse = (value: string | null | undefined): RendererPreference | null =>
  value === "webgpu" || value === "webgl2" || value === "auto" ? value : null

/**
 * Resolve the active preference for this load.
 *
 * Reads the URL query first (per-load override), then the build-time env
 * default, then the hard default. Safe outside the browser (returns the
 * default) so it can run in any environment.
 */
export type ResolveRendererPreference = () => RendererPreference
export const resolveRendererPreference: ResolveRendererPreference = () => {
  if (typeof location !== "undefined") {
    const fromUrl = parse(new URLSearchParams(location.search).get("renderer"))
    if (fromUrl) return fromUrl
  }
  // import.meta.env is defined by Vite; guarded for non-Vite contexts.
  const env = (import.meta as unknown as { env?: Record<string, string> }).env
  const fromEnv = parse(env?.VITE_RENDERER)
  if (fromEnv) return fromEnv

  return DEFAULT_RENDERER
}

/**
 * The one call the app uses: resolve the preference and build the matching
 * Renderer with both backend factories wired in. Callers pass just the
 * canvas; the backend choice is config, not code.
 */
export type CreateConfiguredRenderer = (
  canvas: HTMLCanvasElement,
  preference?: RendererPreference,
) => Promise<Renderer>

export const createConfiguredRenderer: CreateConfiguredRenderer = (
  canvas, preference = resolveRendererPreference(),
) =>
  createRenderer(canvas, preference, {
    webgpu: createWebGpuRenderer,
    webgl2: createWebGl2Renderer,
  })

/**
 * Build ONLY a view-cube scene for its own canvas, backend chosen by the
 * same config. The cube is a self-contained floating control with its own
 * context — it does not want a main-viewport renderer — so this picks the
 * backend and builds the cube directly, without allocating a main scene.
 *
 * Returns the CubeScene plus a dispose that also releases the backend the
 * cube stands up (for the WebGPU path).
 */
export type CreateConfiguredCubeScene = (
  canvas: HTMLCanvasElement,
  preference?: RendererPreference,
) => Promise<CubeScene>

export const createConfiguredCubeScene: CreateConfiguredCubeScene = async (
  canvas, preference = resolveRendererPreference(),
) => {
  const wantGpu =
    preference === "webgpu" || (preference === "auto" && hasWebGpu())

  if (wantGpu) {
    const backend = await createBackend(canvas, "webgpu").catch(() => null)
    if (backend && backend.kind === "webgpu") {
      const gpu = backend as WebGpuBackend
      const cube = createCubeSceneGpu(
        canvas, gpu.device, gpu.context, gpu.format,
      )
      // Wrap dispose so releasing the cube also releases its backend.
      const disposeCube = cube.dispose.bind(cube)
      cube.dispose = () => { disposeCube(); backend.dispose() }
      return cube
    }
    if (preference === "webgpu") {
      throw new Error("WebGPU was requested but is not available")
    }
    // 'auto' falls through to WebGL2 below.
  }

  // WebGL2 cube: its own context on the same canvas, no separate backend
  // object to release.
  return createCubeScene(canvas)
}
