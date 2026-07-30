// =====================================================================
// packages/viewer/gpu-renderer.ts — THE WEBGPU RENDERER FACTORY.
//
// Captures a WebGPU device+context and returns a `Renderer` backed by the
// WebGPU implementations. This is the modern backend: explicit pipelines,
// native MSAA, compute-capable. It renders only where the browser exposes
// WebGPU; the selector in renderer.ts decides when to reach for it.
//
// Both scenes are now complete on WebGPU: the cube (cube-scene-gpu.ts) and
// the main CAD scene, the latter built on the backend-neutral DrawEngine
// (engine/engine-gpu.ts) exactly as the WebGL2 renderer builds its own.
// =====================================================================

import { createBackend, type WebGpuBackend } from "./backend"
import { createScene } from "./scene"
import { createGpuEngine } from "./engine/engine-gpu"
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
  let scene: Scene | null = null

  const renderer: Renderer = {
    kind: "webgpu",
    createScene(): Scene {
      if (!scene) {
        scene = createScene(createGpuEngine(
          backend.canvas, backend.device, backend.context, backend.format,
        ))
      }
      return scene
    },
    createCubeScene(cubeCanvas: HTMLCanvasElement): CubeScene {
      const cube = createCubeSceneGpu(
        cubeCanvas, backend.device, backend.context, backend.format,
      )
      cubeScenes.push(cube)
      return cube
    },
    dispose() {
      scene?.dispose()
      scene = null
      for (const cube of cubeScenes) cube.dispose()
      cubeScenes.length = 0
      backend.dispose()
    },
  }
  return renderer
}
