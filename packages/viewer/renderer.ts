// =====================================================================
// packages/viewer/renderer.ts — THE RENDERER ABSTRACTION.
//
// One API, two implementations, switchable by config. All rendering in the
// viewer goes through the `Renderer` interface; each backend has its OWN
// factory that captures its OWN context (a WebGPU device+context, or a
// WebGL2 gl) and returns an object matching this interface. No classes —
// factory functions returning object literals, matching the codebase style.
//
//   createWebGpuRenderer(canvas, ...) -> Renderer   (packages/viewer/gpu/)
//   createWebGl2Renderer(canvas, ...) -> Renderer   (packages/viewer/gl/)
//
// `createRenderer` is the SELECTOR: it reads the preference and calls the
// right factory. 'auto' picks WebGPU when the browser exposes it, else
// WebGL2 — so a machine without WebGPU still renders, and a machine with it
// uses the modern path. An explicit 'webgpu' or 'webgl2' forces one.
//
// The interface is the DENOMINATOR COMMON to both — nothing WebGPU- or
// WebGL2-specific leaks through it, exactly as the kernel contract keeps
// OCCT out of the layers above it.
// =====================================================================

import type { Scene } from "./index"
import type { CubeScene } from "./cube-scene"

/** Which backend to render with. 'auto' = WebGPU if available, else WebGL2. */
export type RendererKind = "webgpu" | "webgl2"
export type RendererPreference = RendererKind | "auto"

/**
 * A live renderer: the single surface every drawing path goes through.
 *
 * It owns the graphics context for its canvas and hands out the two scene
 * kinds the app draws — the main CAD `Scene` and the view-cube `CubeScene`
 * — each already bound to this renderer's backend. The caller never learns
 * which backend it got; that is the point of the abstraction.
 */
export interface Renderer {
  /** Which backend actually got created (after 'auto' resolved). */
  readonly kind: RendererKind

  /**
   * The main CAD scene, drawn on the primary viewport canvas. One per
   * renderer; created lazily on first access so a renderer used only for
   * the cube pays nothing for the scene.
   */
  createScene(): Scene

  /**
   * The view cube, drawn on its own canvas. Takes that canvas because the
   * cube is a separate, floating control with its own context lifetime.
   */
  createCubeScene(canvas: HTMLCanvasElement): CubeScene

  /** Releases the backend and everything created from it. */
  dispose(): void
}

/**
 * A backend's factory: captures a context for `canvas` and returns a
 * Renderer. Async because WebGPU device acquisition is async; the WebGL2
 * factory resolves immediately. Returns null when the backend is
 * unavailable (no WebGPU adapter, no WebGL2 context) so the selector can
 * fall through rather than throw.
 */
export type RendererFactory = (
  canvas: HTMLCanvasElement,
) => Promise<Renderer | null>

/**
 * Detects whether WebGPU is usable at all — a cheap, throwaway probe used
 * by 'auto'. It only answers the yes/no question; the real device is
 * acquired by the WebGPU factory.
 */
export type HasWebGpu = () => boolean
export const hasWebGpu: HasWebGpu = () =>
  typeof navigator !== "undefined" && "gpu" in navigator

/**
 * The selector. Reads the preference and builds the matching Renderer,
 * capturing the right context for `canvas`.
 *
 *   'webgpu'  -> WebGPU only; rejects if unavailable (no silent WebGL2).
 *   'webgl2'  -> WebGL2 only.
 *   'auto'    -> WebGPU if the browser exposes it, else WebGL2.
 *
 * The two concrete factories are injected rather than imported here, so
 * this selector has no dependency on either backend's code — it is pure
 * contract, and a caller can supply mocks in a test.
 */
export type CreateRenderer = (
  canvas: HTMLCanvasElement,
  preference: RendererPreference,
  factories: {
    readonly webgpu: RendererFactory
    readonly webgl2: RendererFactory
  },
) => Promise<Renderer>

export const createRenderer: CreateRenderer = async (
  canvas, preference, factories,
) => {
  const wantGpu =
    preference === "webgpu" || (preference === "auto" && hasWebGpu())

  if (wantGpu) {
    const renderer = await factories.webgpu(canvas)
    if (renderer) return renderer
    // 'webgpu' was explicit: do NOT fall back — surface the failure.
    if (preference === "webgpu") {
      throw new Error("WebGPU was requested but is not available")
    }
    // 'auto': fall through to WebGL2.
  }

  const webgl = await factories.webgl2(canvas)
  if (webgl) return webgl

  throw new Error(
    "no usable renderer: this browser supports neither WebGPU nor WebGL2",
  )
}
