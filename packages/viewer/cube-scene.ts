// =====================================================================
// packages/viewer/cube-scene.ts — DRAWING THE VIEW CUBE (WebGL2).
//
// A self-contained view-cube renderer that owns its own canvas and context,
// separate from the main viewport's. The DRAWING goes through the shared
// DrawEngine (engine/engine-gl.ts) — the same `cube-face` pipeline and
// `writeLabel` label path the main scene uses — so the cube no longer keeps
// its own shaders, VAO plumbing, or a private copy of the HTML-in-Canvas
// label dance. What stays here is what is genuinely the cube's own: its
// geometry (cube.ts), the per-face UV derivation, its fixed orthographic
// camera, and CPU ray-cast picking.
//
// WHY A SECOND CONTEXT
// --------------------
// The cube needs its own tiny orthographic projection and depth range and
// must be immune to the model's fit/dolly. A second context is one
// allocation at startup and nothing per frame; overlaying it in the main
// pass would mean tearing that pass down and back up around it every frame.
// =====================================================================

import {
  buildCube, pickCube,
  PANEL_HALF, PANEL_CORNER_RADIUS, CORNER_DISTANCE,
  type CubeRegion,
} from "./cube"
import { createGlEngine } from "./engine/engine-gl"
import type { DrawEngine, MeshHandle, LabelHandle, DrawCall } from "./engine/engine"
import { identity, matrixMultiply, orthographic, lookAt, invert, type Matrix } from "./math"
import type { Vector3 } from "@linen/cad/kernel"

/** Half-extent of the orthographic box the cube is drawn into. Sized to the
 *  assembled cube's silhouette (corner discs at CORNER_DISTANCE plus radius)
 *  with a little headroom past that. */
const VIEW_EXTENT = CORNER_DISTANCE + 0.35

/** The half-extent, in cube units, that a panel's label texture spans
 *  (cube-spec.md §5): the panel's FULL extent, so the whole word fits. */
const LABEL_HALF_SPAN = PANEL_HALF + PANEL_CORNER_RADIUS

export interface CubeScene {
  /** Redraws. Called from the host's animation frame. */
  render(azimuth: number, elevation: number, roll: number): void
  /** What is under the cursor, in canvas pixels, or null. */
  pick(x: number, y: number): CubeRegion | null
  /** Lit while the pointer is over it. Set from `pick`. */
  hovered: CubeRegion | null
  resize(size: number, devicePixelRatio: number): void
  dispose(): void
}

/** The BODY colour: one tone for the whole solid (cube-spec.md §5). */
const BODY: Vector3 = [0.185, 0.240, 0.370]
const FACE_COLOR: Vector3 = BODY
const CORNER_COLOR: Vector3 = BODY
const BACK_COLOR: Vector3 = [0.145, 0.180, 0.265]

interface Batch {
  readonly region: CubeRegion
  readonly mesh: MeshHandle
  readonly label: LabelHandle | null
  readonly color: Vector3
}

export const createCubeScene = (canvas: HTMLCanvasElement): CubeScene => {
  const gl = canvas.getContext("webgl2", {
    antialias: true,
    depth: true,
    alpha: true,
    premultipliedAlpha: false,
  })
  if (!gl) throw new Error("the view cube needs WebGL2")
  return createCubeSceneOnEngine(canvas, createGlEngine(canvas, gl))
}

/**
 * The backend-neutral view cube: everything except which engine drew it.
 * Both the WebGL2 (`createCubeScene`) and WebGPU (`createCubeSceneGpu`)
 * entry points build the right engine and hand it here. The engine is owned
 * by the returned scene and disposed with it.
 */
export type CreateCubeSceneOnEngine = (
  canvas: HTMLCanvasElement, engine: DrawEngine,
) => CubeScene

export const createCubeSceneOnEngine: CreateCubeSceneOnEngine = (canvas, engine) => {
  const regions = buildCube()

  // --- geometry + labels, uploaded once -------------------------------
  // One position-uv mesh per part, plus a label for the face panels. The
  // parts never change, so this is built once.
  const batches: Batch[] = regions.map((region) => {
    const data = interleaveRegion(region)
    const mesh = engine.createMesh(data, "position-uv")
    const label =
      region.kind === "face" ? engine.writeLabel(region.label, "cube-face") : null
    const color =
      region.kind === "corner" ? CORNER_COLOR
        : region.kind === "back" ? BACK_COLOR
          : FACE_COLOR
    return { region, mesh, label, color }
  })

  /** Kept so `pick` can unproject with the same matrix that was drawn. */
  let lastViewProjection: Matrix = identity()
  let pixelSize = 1
  const state = { hovered: null as CubeRegion | null }

  /**
   * The camera that looks at the cube: mirrors the model camera's
   * ORIENTATION but not its distance or target, so the cube is always
   * centred and the same size. Orthographic, so the near corner does not
   * swell relative to the far one.
   */
  const viewProjectionFor = (
    azimuth: number, elevation: number, roll: number,
  ): Matrix => {
    const horizontal = Math.cos(elevation)
    const eye: Vector3 = [
      horizontal * Math.cos(azimuth) * 4,
      horizontal * Math.sin(azimuth) * 4,
      Math.sin(elevation) * 4,
    ]
    const forward: Vector3 = [-eye[0] / 4, -eye[1] / 4, -eye[2] / 4]
    let worldUp: Vector3 = [
      -Math.sin(elevation) * Math.cos(azimuth),
      -Math.sin(elevation) * Math.sin(azimuth),
      Math.cos(elevation),
    ]
    if (Math.hypot(worldUp[0], worldUp[1], worldUp[2]) < 1e-9) {
      worldUp = [-Math.cos(azimuth), -Math.sin(azimuth), 0]
    }
    const cosRoll = Math.cos(roll)
    const sinRoll = Math.sin(roll)
    const dot =
      forward[0] * worldUp[0] + forward[1] * worldUp[1] + forward[2] * worldUp[2]
    const cross: Vector3 = [
      forward[1] * worldUp[2] - forward[2] * worldUp[1],
      forward[2] * worldUp[0] - forward[0] * worldUp[2],
      forward[0] * worldUp[1] - forward[1] * worldUp[0],
    ]
    const up: Vector3 = [
      worldUp[0] * cosRoll + cross[0] * sinRoll + forward[0] * dot * (1 - cosRoll),
      worldUp[1] * cosRoll + cross[1] * sinRoll + forward[1] * dot * (1 - cosRoll),
      worldUp[2] * cosRoll + cross[2] * sinRoll + forward[2] * dot * (1 - cosRoll),
    ]
    return matrixMultiply(
      orthographic(VIEW_EXTENT * 2, 1, -10, 10),
      lookAt(eye, [0, 0, 0], up),
    )
  }

  return {
    get hovered() { return state.hovered },
    set hovered(region: CubeRegion | null) { state.hovered = region },

    render(azimuth, elevation, roll) {
      const viewProjection = viewProjectionFor(azimuth, elevation, roll)
      lastViewProjection = viewProjection

      // One flat draw per part under the cube-face pipeline (depth test +
      // write, cull back — the two-plate winding shows one plate per side).
      // Panels carry their DOM label; corner discs are a plain lighter tone.
      const draws: DrawCall[] = batches.map((batch) => ({
        mesh: batch.mesh,
        pipeline: "cube-face",
        label: batch.label,
        uniforms: {
          viewProjection,
          color: batch.color,
          highlighted: state.hovered?.id === batch.region.id ? 1 : 0,
          labelled: batch.label ? 1 : 0,
        },
      }))

      // Transparent clear: the cube floats over the HUD.
      engine.frame({ clear: [0, 0, 0, 0] }, draws)
    },

    pick(x, y) {
      const clipX = (x / (canvas.width / pixelSize)) * 2 - 1
      const clipY = 1 - (y / (canvas.height / pixelSize)) * 2
      const inverse = invert(lastViewProjection)
      if (!inverse) return null
      const unproject = (z: number): Vector3 => {
        const w =
          inverse[3]! * clipX + inverse[7]! * clipY + inverse[11]! * z + inverse[15]!
        return [
          (inverse[0]! * clipX + inverse[4]! * clipY + inverse[8]! * z + inverse[12]!) / w,
          (inverse[1]! * clipX + inverse[5]! * clipY + inverse[9]! * z + inverse[13]!) / w,
          (inverse[2]! * clipX + inverse[6]! * clipY + inverse[10]! * z + inverse[14]!) / w,
        ]
      }
      const near = unproject(-1)
      const far = unproject(1)
      const direction: Vector3 = [
        far[0] - near[0], far[1] - near[1], far[2] - near[2],
      ]
      return pickCube(regions, near, direction)
    },

    resize(size, devicePixelRatio) {
      pixelSize = devicePixelRatio
      engine.resize(size, size, devicePixelRatio)
    },

    dispose() {
      for (const batch of batches) {
        engine.destroyMesh(batch.mesh)
        if (batch.label) engine.destroyLabel(batch.label)
      }
      engine.dispose()
    },
  }
}

/**
 * Build a region's interleaved (x,y,z,u,v) vertex data.
 *
 * Face panels map each vertex onto the face plane's two in-plane axes and
 * into label space [0,1] over ±LABEL_HALF_SPAN, choosing "up" so every face
 * reads upright (world Z up on the vertical faces; world Y on Top/Bottom,
 * where Z is the normal). Non-face parts carry (0,0) UVs — they are unlabelled
 * and the cube-face shader treats out-of-[0,1] UVs as "no label" anyway.
 */
const interleaveRegion = (region: CubeRegion): Float32Array => {
  const vertexCount = region.positions.length / 3
  const out = new Float32Array(vertexCount * 5)

  if (region.kind !== "face") {
    for (let i = 0; i < vertexCount; i++) {
      out[i * 5 + 0] = region.positions[i * 3 + 0]!
      out[i * 5 + 1] = region.positions[i * 3 + 1]!
      out[i * 5 + 2] = region.positions[i * 3 + 2]!
      // u, v left at 0.
    }
    return out
  }

  const normal = region.normal
  const upWorld: Vector3 = Math.abs(normal[2]) > 0.5 ? [0, 1, 0] : [0, 0, 1]
  const right: Vector3 = [
    upWorld[1] * normal[2] - upWorld[2] * normal[1],
    upWorld[2] * normal[0] - upWorld[0] * normal[2],
    upWorld[0] * normal[1] - upWorld[1] * normal[0],
  ]
  const rightLength = Math.hypot(right[0], right[1], right[2]) || 1
  const unitRight: Vector3 = [
    right[0] / rightLength, right[1] / rightLength, right[2] / rightLength,
  ]
  const up = upWorld

  for (let i = 0; i < vertexCount; i++) {
    const x = region.positions[i * 3 + 0]!
    const y = region.positions[i * 3 + 1]!
    const z = region.positions[i * 3 + 2]!
    const u =
      (x * unitRight[0] + y * unitRight[1] + z * unitRight[2]) /
        (2 * LABEL_HALF_SPAN) + 0.5
    const v =
      (x * up[0] + y * up[1] + z * up[2]) / (2 * LABEL_HALF_SPAN) + 0.5
    out[i * 5 + 0] = x
    out[i * 5 + 1] = y
    out[i * 5 + 2] = z
    out[i * 5 + 3] = u
    out[i * 5 + 4] = 1 - v // V flipped: texture space grows downward.
  }
  return out
}
