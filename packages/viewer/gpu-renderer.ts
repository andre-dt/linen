// =====================================================================
// packages/viewer/gpu-renderer.ts — THE WEBGPU RENDERER FACTORY.
//
// Captures a WebGPU device+context and returns a `Renderer` backed by the
// WebGPU implementations. This is the modern backend: explicit pipelines,
// native MSAA, compute-capable. It renders only where the browser exposes
// WebGPU; the selector in renderer.ts decides when to reach for it.
//
// The cube has a complete WebGPU implementation (cube-scene-gpu.ts). The
// main CAD scene's WebGPU renderer is the remaining port; until it lands,
// createScene throws a clear, explicit error so a caller that selected
// WebGPU for the main viewport learns exactly what is missing rather than
// getting a blank canvas.
// =====================================================================

import { createBackend, type WebGpuBackend } from "./backend"
import { createCubeSceneGpu } from "./cube-scene-gpu"
import type { Renderer, RendererFactory } from "./renderer"
import type { Scene } from "./index"
import type { CubeScene } from "./cube-scene"

export const createWebGpuRenderer: RendererFactory = async (canvas) => {
  let backend: WebGpuBackend
  try {
    const created = await createBackend(canvas, "webgpu")
    if (created.kind !== "webgpu") {
      created.dispose()
      return null
    }
    backend = created as WebGpuBackend
  } catch {
    return null
  }

  const cubeScenes: CubeScene[] = []

  const renderer: Renderer = {
    kind: "webgpu",
    createScene(): Scene {
      // The WebGPU main-scene renderer is the next port. Explicit rather
      // than silent: selecting WebGPU for the main viewport before this
      // exists must say so, not paint nothing.
      throw new Error(
        "the WebGPU main-scene renderer is not implemented yet — " +
        "select 'webgl2' or 'auto' for the main viewport",
      )
    },
    createCubeScene(cubeCanvas: HTMLCanvasElement): CubeScene {
      const cube = createCubeSceneGpu(
        cubeCanvas, backend.device, backend.context, backend.format,
      )
      cubeScenes.push(cube)
      return cube
    },
    dispose() {
      for (const cube of cubeScenes) cube.dispose()
      cubeScenes.length = 0
      backend.dispose()
    },
  }
  return renderer
}
