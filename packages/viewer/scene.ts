// =====================================================================
// packages/viewer/scene.ts — THE MAIN CAD SCENE, on the DrawEngine.
//
// Draws the model: bodies, the datum planes and their names, the origin
// marker, and the live sketch. It is backend-NEUTRAL — every pixel goes
// through the DrawEngine contract, so this one file serves both the WebGL2
// and WebGPU renderers. No `gl.*`, no `GPUDevice`, no shader lives here;
// the engine owns all of that. The scene's job is composition: what to
// draw, in what order, under which named pipeline.
//
// Imperative on purpose: no signal reads anything written here, and nothing
// here schedules DOM work (the engine's label path is the one exception,
// and it is self-driving).
//
// LABELS ARE HTML NOW
// -------------------
// Plane names come from `engine.writeLabel(name, "plane")` — a real,
// browser-laid-out HTML element copied to a texture, the same path the view
// cube uses. That is why the names are crisp at every angle where the old
// canvas2D bitmap softened. The caller passes only the text and a style
// token; the engine owns the font and colour.
// =====================================================================

import type { BodyId } from "@linen/cad/kernel"
import type {
  Scene, Drawable, Appearance, HighlightState,
} from "./index"
import type { PlaneLayer, SketchLayer } from "./index"
import type { DrawEngine, MeshHandle, LabelHandle, DrawCall } from "./engine/engine"
import {
  sketchBuffer, rayToSketch, snap,
  type SketchCurve,
} from "./sketch"
import { decodeMesh } from "./mesh"
import { createCamera } from "./camera"
import { invert, type Matrix } from "./math"
import {
  DATUM_PLANES, PLANE_EXTENT, planeQuad, planeOutline, planeLabelQuad,
  originSphere, pickPlane, rayThrough,
  type DatumPlaneId,
} from "./planes"

/** The three surfaces that actually carry geometry. Their opposites —
 *  bottom, back, left — are the same squares seen from the other side. */
const FRONT_FACES: ReadonlySet<DatumPlaneId> = new Set<DatumPlaneId>([
  "top", "front", "right",
])

/** A plane and its opposite share one drawn square, so a hover on either
 *  has to light the same geometry. */
const OPPOSITE: Record<DatumPlaneId, DatumPlaneId> = {
  top: "bottom", bottom: "top",
  front: "back", back: "front",
  right: "left", left: "right",
}

const dotProduct = (a: readonly number[], b: readonly number[]): number =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!

const crossProduct = (
  a: readonly number[],
  b: readonly number[],
): readonly [number, number, number] => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
]

const normalized = (a: readonly number[]): readonly [number, number, number] => {
  const magnitude = Math.hypot(a[0]!, a[1]!, a[2]!)
  return magnitude < 1e-12
    ? [a[0]!, a[1]!, a[2]!]
    : [a[0]! / magnitude, a[1]! / magnitude, a[2]! / magnitude]
}

const DEFAULT_APPEARANCE: Appearance = {
  color: [0.62, 0.66, 0.72],
  metallic: 0.1,
  roughness: 0.55,
  opacity: 1,
  showEdges: true,
}

/** One body's GPU mesh handle plus the triangle count for bookkeeping. */
interface BodyMesh {
  readonly handle: MeshHandle
}

/**
 * Interleave separate position and normal arrays into the engine's
 * `position-normal` layout (x,y,z,nx,ny,nz per vertex). Bodies arrive
 * de-interleaved from the mesh codec; every other source is already
 * interleaved.
 */
const interleavePositionNormal = (
  positions: Float32Array,
  normals: Float32Array,
): Float32Array => {
  const vertexCount = positions.length / 3
  const out = new Float32Array(vertexCount * 6)
  for (let i = 0; i < vertexCount; i++) {
    out[i * 6 + 0] = positions[i * 3 + 0]!
    out[i * 6 + 1] = positions[i * 3 + 1]!
    out[i * 6 + 2] = positions[i * 3 + 2]!
    out[i * 6 + 3] = normals[i * 3 + 0]!
    out[i * 6 + 4] = normals[i * 3 + 1]!
    out[i * 6 + 5] = normals[i * 3 + 2]!
  }
  return out
}

export type CreateScene = (engine: DrawEngine) => Scene

export const createScene: CreateScene = (engine) => {
  const drawables = new Map<BodyId, Drawable>()
  const meshes = new Map<BodyId, BodyMesh>()
  const camera = createCamera()

  const highlight: HighlightState = {
    hovered: null,
    selected: new Set(),
    candidates: null,
    invalid: new Set(),
  }

  let width = 1
  let height = 1
  let devicePixelRatio = 1
  /** Wall clock of the previous frame, for time-based animation. */
  let lastFrameAt: number | null = null

  // --- datum plane meshes + labels, built once ------------------------
  // Only the THREE distinct surfaces get geometry; opposites are the same
  // square seen from the other side (picking still distinguishes all six).
  const planeMeshes = DATUM_PLANES.filter((plane) => FRONT_FACES.has(plane.id)).map(
    (plane) => {
      // The name, as an HTML-in-Canvas label — crisp at every angle. The
      // engine owns the font/colour; we pass the word and the style token.
      const label = engine.writeLabel(plane.label, "plane")
      // Two quads, built once: the normal one and its mirror. A plane is
      // drawn two-sided, so from behind its front face the glyphs read
      // backwards — and which side the camera is on changes as it orbits.
      // Choosing between two static meshes per frame beats re-uploading.
      const width = LABEL_HEIGHT_MM * label.aspect
      return {
        plane,
        fill: engine.createMesh(planeQuad(plane), "position"),
        outline: engine.createMesh(planeOutline(plane), "position"),
        label,
        labelMesh: engine.createMesh(
          planeLabelQuad(plane, width, LABEL_HEIGHT_MM), "position-uv",
        ),
        labelMirroredMesh: engine.createMesh(
          planeLabelQuad(plane, width, LABEL_HEIGHT_MM, PLANE_EXTENT, 2, true),
          "position-uv",
        ),
      }
    },
  )

  // The origin marker, shared by all three planes.
  const originMesh = engine.createMesh(originSphere(), "position-normal")

  const planes: PlaneLayer = {
    visible: true,
    hovered: null,
    selected: null,

    pick(x, y) {
      const inverse = invert(camera.viewProjection(width / height))
      if (!inverse) return null
      return pickPlane(rayThrough(x, y, width, height, inverse))
    },
  }

  // --- the sketch: three dynamic meshes, re-uploaded on change --------
  // A sketch is hundreds of vertices, so a generous fixed capacity avoids
  // ever reallocating while the rubber band is live. Three separate meshes
  // (committed / pending / cursor) rather than one, because each batch draws
  // in its own colour — and one draw cannot switch colour mid-buffer.
  const SKETCH_CAPACITY = 4096
  const sketchCommittedMesh = engine.createDynamicMesh("position", SKETCH_CAPACITY)
  const sketchPendingMesh = engine.createDynamicMesh("position", SKETCH_CAPACITY)
  const sketchCursorMesh = engine.createDynamicMesh("position", 64)

  const sketch: SketchLayer = {
    frame: null,
    curves: [],
    pending: null,
    cursor: null,
    snappedTo: null,

    locate(x, y) {
      if (!sketch.frame) return null
      const inverse = invert(camera.viewProjection(width / height))
      if (!inverse) return null
      const ray = rayThrough(x, y, width, height, inverse)
      const raw = rayToSketch(sketch.frame, ray.origin, ray.direction)
      if (!raw) return null
      return snap(raw, sketch.curves, snapTolerance())
    },
  }

  const snapTolerance = (): number => worldPerPixel() * 10

  const worldPerPixel = (): number => {
    const projection = camera.projection
    const distance = Math.hypot(
      camera.position[0] - camera.target[0],
      camera.position[1] - camera.target[1],
      camera.position[2] - camera.target[2],
    )
    if (projection.kind === "orthographic") {
      return projection.height / Math.max(height, 1)
    }
    const visible = 2 * distance * Math.tan(projection.fieldOfView / 2)
    return visible / Math.max(height, 1)
  }

  // =====================================================================
  // DRAW-CALL ASSEMBLY
  // =====================================================================

  /** The body draws: lit meshes in their own frame, opaque. */
  const bodyDraws = (viewProjection: Matrix): DrawCall[] => {
    const draws: DrawCall[] = []
    for (const [body, drawable] of drawables) {
      if (!drawable.visible) continue
      const mesh = meshes.get(body)
      if (!mesh) continue
      const color = highlight.selected.has(body as never)
        ? SELECTED_COLOR
        : highlight.hovered === (body as never)
          ? HOVER_COLOR
          : drawable.appearance.color
      draws.push({
        mesh: mesh.handle,
        pipeline: "lit-mesh",
        uniforms: {
          viewProjection,
          model: drawable.transform as unknown as Matrix,
          color: color as readonly [number, number, number],
          lightDirection: [0.4, 0.6, 0.7],
        },
      })
    }
    return draws
  }

  /** The datum planes: fills, outlines, names, then the origin marker. */
  const planeDraws = (viewProjection: Matrix): DrawCall[] => {
    if (!planes.visible) return []
    const draws: DrawCall[] = []

    for (const { plane, fill, outline } of planeMeshes) {
      const opposite = OPPOSITE[plane.id]
      const state =
        planes.selected === plane.id || planes.selected === opposite ? "selected"
        : planes.hovered === plane.id || planes.hovered === opposite ? "hovered"
        : "idle"
      const color = state === "idle" ? PLANE_COLOR : PLANE_ACTIVE_COLOR
      const fillOpacity =
        state === "selected" ? 0.26 : state === "hovered" ? 0.2 : 0.09

      draws.push({
        mesh: fill, pipeline: "flat-fill",
        uniforms: { viewProjection, color, opacity: fillOpacity },
      })
      draws.push({
        mesh: outline, pipeline: "flat-line",
        uniforms: {
          viewProjection, color,
          opacity: state === "idle" ? 0.32 : 0.85,
        },
      })
    }

    // The names. Screen basis decides which planes read backwards.
    const eye = camera.position
    const forward = normalized([
      camera.target[0] - eye[0], camera.target[1] - eye[1], camera.target[2] - eye[2],
    ])
    const screenRight = normalized(crossProduct([0, 0, 1], forward))
    const screenUp = crossProduct(forward, screenRight)

    for (const { plane, label, labelMesh, labelMirroredMesh } of planeMeshes) {
      // Is this plane's face turned toward the camera? Project its (right,
      // up) axes to screen and take their 2D cross product; the sign is the
      // handedness of the projected frame.
      const runX = dotProduct(plane.right, screenRight)
      const runY = dotProduct(plane.right, screenUp)
      const upX = dotProduct(plane.up, screenRight)
      const upY = dotProduct(plane.up, screenUp)
      const rightReading = runX * upY - runY * upX < 0

      const opposite = OPPOSITE[plane.id]
      const active =
        planes.selected === plane.id || planes.selected === opposite ||
        planes.hovered === plane.id || planes.hovered === opposite
      const color = active ? PLANE_ACTIVE_COLOR : LABEL_COLOR

      draws.push({
        mesh: rightReading ? labelMesh : labelMirroredMesh,
        pipeline: "label",
        label,
        uniforms: { viewProjection, color, opacity: active ? 1 : 0.85 },
      })
    }

    // The origin marker, opaque and screen-space-sized.
    draws.push({
      mesh: originMesh,
      pipeline: "origin-billboard",
      uniforms: {
        viewProjection,
        lightDirection: [0.4, 0.6, 0.7],
        viewport: [
          Math.max(1, Math.round(width * devicePixelRatio)),
          Math.max(1, Math.round(height * devicePixelRatio)),
        ],
        pixelRadius: ORIGIN_PIXEL_RADIUS * devicePixelRatio,
      },
    })
    return draws
  }

  /** The sketch: committed curves, the rubber band, the snapped cursor.
   *  Each batch is uploaded into its own dynamic mesh, then all are returned
   *  as draws in one frame. A batch with no geometry contributes nothing. */
  const sketchDraws = (viewProjection: Matrix): DrawCall[] => {
    if (!sketch.frame) return []
    const draws: DrawCall[] = []
    const emit = (
      mesh: MeshHandle,
      curves: readonly SketchCurve[],
      color: readonly [number, number, number],
      opacity: number,
    ): void => {
      if (curves.length === 0) return
      const data = sketchBuffer(sketch.frame!, curves)
      if (data.length === 0) return
      const vertexCount = data.length / 3
      if (vertexCount > (mesh === sketchCursorMesh ? 64 : SKETCH_CAPACITY)) return
      engine.updateMesh(mesh, data, vertexCount)
      draws.push({
        mesh, pipeline: "sketch-line",
        uniforms: { viewProjection, color, opacity },
      })
    }
    emit(sketchCommittedMesh, sketch.curves, SKETCH_COLOR, 1)
    if (sketch.pending) {
      emit(sketchPendingMesh, [sketch.pending], SKETCH_PENDING_COLOR, 0.85)
    }
    if (sketch.cursor) {
      emit(
        sketchCursorMesh, [{ kind: "point", at: sketch.cursor }],
        sketch.snappedTo ? SKETCH_SNAP_COLOR : SKETCH_CURSOR_COLOR, 1,
      )
    }
    return draws
  }

  return {
    camera,
    highlight,
    drawables,
    planes,
    sketch,

    upload(body, buffer) {
      const previous = meshes.get(body)
      if (previous) engine.destroyMesh(previous.handle)

      const mesh = decodeMesh(buffer)
      const handle = engine.createMesh(
        interleavePositionNormal(mesh.positions, mesh.normals),
        "position-normal",
        mesh.indices,
      )
      meshes.set(body, { handle })

      const drawable: Drawable = {
        body,
        bounds: mesh.bounds,
        triangleCount: mesh.indices.length / 3,
        transform: IDENTITY,
        visible: true,
        appearance: DEFAULT_APPEARANCE,
      }
      drawables.set(body, drawable)
      return drawable
    },

    remove(body) {
      const mesh = meshes.get(body)
      if (mesh) engine.destroyMesh(mesh.handle)
      meshes.delete(body)
      drawables.delete(body)
    },

    clear() {
      for (const mesh of meshes.values()) engine.destroyMesh(mesh.handle)
      meshes.clear()
      drawables.clear()
    },

    render() {
      const now = performance.now()
      const deltaSeconds = lastFrameAt === null ? 0 : (now - lastFrameAt) / 1000
      lastFrameAt = now
      camera.advance(Math.min(deltaSeconds, 0.1))

      const viewProjection = camera.viewProjection(width / height)

      // Assemble the frame's draws in order: bodies first (opaque), then the
      // planes and origin (translucent, blended over the bodies), then the
      // sketch last of all (on top of everything, including its own plane).
      // sketchDraws uploads each batch into its dynamic mesh as it goes, so
      // the meshes hold the right vertices by the time the engine draws.
      const draws: DrawCall[] = [
        ...bodyDraws(viewProjection),
        ...planeDraws(viewProjection),
        ...sketchDraws(viewProjection),
      ]
      engine.frame({ clear: CLEAR }, draws)
    },

    resize(nextWidth, nextHeight, dpr) {
      width = nextWidth
      height = nextHeight
      devicePixelRatio = dpr
      engine.resize(nextWidth, nextHeight, dpr)
    },

    dispose() {
      for (const mesh of meshes.values()) engine.destroyMesh(mesh.handle)
      meshes.clear()
      drawables.clear()
      for (const pm of planeMeshes) {
        engine.destroyMesh(pm.fill)
        engine.destroyMesh(pm.outline)
        engine.destroyMesh(pm.labelMesh)
        engine.destroyMesh(pm.labelMirroredMesh)
        engine.destroyLabel(pm.label)
      }
      engine.destroyMesh(originMesh)
      engine.destroyMesh(sketchCommittedMesh)
      engine.destroyMesh(sketchPendingMesh)
      engine.destroyMesh(sketchCursorMesh)
      engine.dispose()
    },
  }
}

const IDENTITY = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]) as unknown as Drawable["transform"]

/** Opaque scene clear, matching --surface. */
const CLEAR: readonly [number, number, number, number] = [0.086, 0.094, 0.114, 1]

const HOVER_COLOR: readonly [number, number, number] = [0.44, 0.7, 1]
const SELECTED_COLOR: readonly [number, number, number] = [0.31, 0.56, 0.97]

const PLANE_COLOR: readonly [number, number, number] = [0.62, 0.70, 0.82]
const PLANE_ACTIVE_COLOR: readonly [number, number, number] = [0.44, 0.7, 1]

/** Cap height of a plane's name, in millimetres. */
const LABEL_HEIGHT_MM = 6
const LABEL_COLOR: readonly [number, number, number] = [0.96, 0.97, 1]

const SKETCH_COLOR: readonly [number, number, number] = [0.93, 0.95, 0.98]
const SKETCH_PENDING_COLOR: readonly [number, number, number] = [0.44, 0.7, 1]
const SKETCH_CURSOR_COLOR: readonly [number, number, number] = [0.7, 0.75, 0.82]
const SKETCH_SNAP_COLOR: readonly [number, number, number] = [1, 0.75, 0.28]

/** The origin marker's on-screen radius, in CSS pixels (scaled by DPR). */
const ORIGIN_PIXEL_RADIUS = 4.5
