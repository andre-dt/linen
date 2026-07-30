// =====================================================================
// packages/viewer/cube-scene-gpu.ts — THE VIEW CUBE, IN WEBGPU.
//
// The WebGPU entry point for the view cube. It is now a thin wrapper: it
// builds a WebGPU DrawEngine over the cube's canvas/device/context and hands
// it to the backend-neutral cube in cube-scene.ts. Everything that used to
// live here — the WGSL, the pipeline, MSAA targets, the per-part uniform
// buffer, the copyElementImageToTexture label path — is now the engine's
// job (engine/engine-gpu.ts), shared with the main scene. The cube's own
// logic (geometry, UVs, orthographic camera, ray-cast picking) lives once in
// cube-scene.ts and serves both backends.
// =====================================================================

import { createCubeSceneOnEngine, type CubeScene } from "./cube-scene"
import { createGpuEngine } from "./engine/engine-gpu"

/** Kept for callers that still import the WebGPU cube type by this name. */
export type CubeSceneGpu = CubeScene

export type CreateCubeSceneGpu = (
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  context: GPUCanvasContext,
  format: GPUTextureFormat,
) => CubeScene

export const createCubeSceneGpu: CreateCubeSceneGpu = (
  canvas, device, context, format,
) => {
  // The cube floats over the HUD, so its canvas must be TRANSPARENT where
  // nothing is drawn. Reconfigure this context for premultiplied alpha (the
  // engine clears fully transparent); the shared backend uses "opaque".
  context.configure({
    device,
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    alphaMode: "premultiplied",
  })
  return createCubeSceneOnEngine(
    canvas, createGpuEngine(canvas, device, context, format),
  )
}
