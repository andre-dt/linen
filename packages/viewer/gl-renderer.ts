// =====================================================================
// packages/viewer/gl-renderer.ts — THE WEBGL2 RENDERER FACTORY.
//
// Captures a WebGL2 context and returns a `Renderer` backed by the
// existing WebGL2 scene and cube implementations. This is the mature,
// works-everywhere backend; it is verifiable in every browser today.
//
// The factory owns the main viewport's WebGL2 backend; the cube keeps its
// own context (it is a separate floating canvas), created per call.
// =====================================================================

import { createBackend } from "./backend"
import { createScene } from "./scene"
import { createCubeScene } from "./cube-scene"
import type { Renderer, RendererFactory } from "./renderer"
import type { Scene } from "./index"
import type { CubeScene } from "./cube-scene"

export const createWebGl2Renderer: RendererFactory = async (canvas) => {
  let backend
  try {
    backend = await createBackend(canvas, "webgl2")
  } catch {
    return null
  }
  if (backend.kind !== "webgl2") {
    backend.dispose()
    return null
  }

  let scene: Scene | null = null

  const renderer: Renderer = {
    kind: "webgl2",
    createScene() {
      if (!scene) scene = createScene(backend)
      return scene
    },
    createCubeScene(cubeCanvas: HTMLCanvasElement): CubeScene {
      // The cube owns its own context (separate floating canvas), so it is
      // built directly rather than from this renderer's backend.
      return createCubeScene(cubeCanvas)
    },
    dispose() {
      scene?.dispose()
      scene = null
      backend.dispose()
    },
  }
  return renderer
}
