// =====================================================================
// packages/viewer/scene.ts
//
// Draws the model. Imperative on purpose: no signal reads anything
// written here, and nothing here schedules DOM work.
//
// WebGL2 first. It runs everywhere, so the whole client can be built
// and debugged before the WebGPU path exists — and it stays as the
// fallback afterwards, which means it has to work regardless.
// =====================================================================

import type { BodyId } from "@linen/cad/kernel"
import type {
  Backend, Scene, Drawable, Appearance, Camera, HighlightState,
  Projection, StandardView,
} from "./index"
import type { WebGl2Backend } from "./backend"
import type { PlaneLayer, SketchLayer } from "./index"
import {
  sketchBuffer, rayToSketch, snap,
  type SketchCurve,
} from "./sketch"
import { createTextTexture, type TextTexture } from "./text"
import { decodeMesh } from "./mesh"
import { createCamera } from "./camera"
import { matrixMultiply, invert, type Matrix } from "./math"
import {
  DATUM_PLANES, PLANE_EXTENT, planeQuad, planeOutline, planeLabelQuad,
  originSphere, originSphereVertexCount, pickPlane, rayThrough,
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

interface GpuMesh {
  readonly positions: WebGLBuffer
  readonly normals: WebGLBuffer
  readonly indices: WebGLBuffer
  readonly indexCount: number
  readonly vertexArray: WebGLVertexArrayObject
}

export function createScene(backend: Backend): Scene {
  if (backend.kind !== "webgl2") {
    throw new Error("the WebGPU renderer is not implemented yet")
  }
  const { gl } = backend as WebGl2Backend

  const program = buildProgram(gl)
  const uniforms = {
    viewProjection: gl.getUniformLocation(program, "uViewProjection"),
    model: gl.getUniformLocation(program, "uModel"),
    color: gl.getUniformLocation(program, "uColor"),
    lightDirection: gl.getUniformLocation(program, "uLightDirection"),
  }

  const drawables = new Map<BodyId, Drawable>()
  const meshes = new Map<BodyId, GpuMesh>()
  const camera = createCamera()

  const highlight: HighlightState = {
    hovered: null,
    selected: new Set(),
    candidates: null,
    invalid: new Set(),
  }

  let width = 1
  let height = 1
  /** Wall clock of the previous frame, for time-based animation. */
  let lastFrameAt: number | null = null

  gl.enable(gl.DEPTH_TEST)
  gl.enable(gl.CULL_FACE)
  gl.cullFace(gl.BACK)
  gl.clearColor(0.086, 0.094, 0.114, 1) // matches --surface

  // --- the datum planes -------------------------------------------------
  // Uploaded once at construction: six squares is a trivial amount of
  // geometry and it never changes, so there is nothing to stream.
  const planeProgram = buildPlaneProgram(gl)
  const planeUniforms = {
    viewProjection: gl.getUniformLocation(planeProgram, "uViewProjection"),
    color: gl.getUniformLocation(planeProgram, "uColor"),
    opacity: gl.getUniformLocation(planeProgram, "uOpacity"),
  }
  // Only the THREE distinct surfaces get geometry. Top and Bottom are the
  // same square seen from either side — uploading both would draw every
  // plane twice, doubling the fill cost and darkening the blend.
  // Picking still distinguishes all six; that is a ray test, not geometry.
  // The name, baked to a texture and stamped INTO the plane. Built once:
  // six fixed words that never change.
  const labelProgram = buildLabelProgram(gl)
  const labelUniforms = {
    viewProjection: gl.getUniformLocation(labelProgram, "uViewProjection"),
    color: gl.getUniformLocation(labelProgram, "uColor"),
    opacity: gl.getUniformLocation(labelProgram, "uOpacity"),
    text: gl.getUniformLocation(labelProgram, "uText"),
  }

  const planeMeshes = DATUM_PLANES.filter((plane) => FRONT_FACES.has(plane.id)).map(
    (plane) => {
      // The label as written — "Top", not "TOP". Sentence case reads
      // faster at this size, and the all-caps tracking that made the
      // uppercase legible is unnecessary once the word has ascenders and
      // descenders to give it shape.
      const text = createTextTexture(gl, plane.label, {
        fontSize: 32,
        letterSpacing: 0.5,
      })
      return {
        plane,
        fill: createPlaneBuffer(gl, planeProgram, planeQuad(plane)),
        outline: createPlaneBuffer(gl, planeProgram, planeOutline(plane)),
        text,
        // Sized in MILLIMETRES, from the texture's aspect so the glyphs
        // are never stretched. The label scales with the plane, as
        // anything printed on a surface does.
        // TWO quads, built once: the normal one and its mirror. A plane
        // is drawn two-sided, so from behind its front face the glyphs
        // read backwards — and which side the camera is on changes as it
        // orbits. Choosing between two static buffers per frame beats
        // re-uploading geometry every time the view crosses the plane.
        label: text
          ? createLabelBuffer(
              gl, labelProgram,
              planeLabelQuad(plane, LABEL_HEIGHT_MM * text.aspect, LABEL_HEIGHT_MM),
            )
          : null,
        labelMirrored: text
          ? createLabelBuffer(
              gl, labelProgram,
              planeLabelQuad(
                plane, LABEL_HEIGHT_MM * text.aspect, LABEL_HEIGHT_MM,
                PLANE_EXTENT, 2, true,
              ),
            )
          : null,
      }
    },
  )

  // The origin, shared by all three planes rather than owned by any.
  const originProgram = buildOriginProgram(gl)
  const originUniforms = {
    viewProjection: gl.getUniformLocation(originProgram, "uViewProjection"),
    lightDirection: gl.getUniformLocation(originProgram, "uLightDirection"),
    viewport: gl.getUniformLocation(originProgram, "uViewport"),
    pixelRadius: gl.getUniformLocation(originProgram, "uPixelRadius"),
  }
  const originVertexArray = createOriginBuffer(gl, originProgram, originSphere())
  const originVertexCount = originSphereVertexCount()

  const planes: PlaneLayer = {
    // Visible by default: the origin planes ARE the empty scene, the
    // same way Onshape shows them the moment a part opens. Hiding them
    // until something asks would leave a new part staring at nothing.
    visible: true,
    hovered: null,
    selected: null,

    pick(x, y) {
      const inverse = invert(camera.viewProjection(width / height))
      // A singular view-projection means the camera is degenerate; no
      // ray can be built from it, so nothing is hit.
      if (!inverse) return null
      return pickPlane(rayThrough(x, y, width, height, inverse))
    }
  }

  /**
   * Draws the datum planes: a translucent fill plus a solid border.
   *
   * Depth WRITING is off while they draw. A plane is a hint, not
   * material — writing depth would let the near half of a plane occlude
   * the far half of another, and the six of them all cross at the origin.
   * Depth TESTING stays on, so a plane behind a solid is still hidden by
   * it, which is what makes the two read as sharing one space.
   *
   * Culling is off too: a plane is a surface with no thickness, and the
   * user orbits freely. One-sidedness belongs to PICKING (which of a
   * pair you can click), not to whether the quad is visible at all.
   */
  const drawPlanes = (viewProjection: Matrix): void => {
    if (!planes.visible) return

    gl.useProgram(planeProgram)
    gl.uniformMatrix4fv(planeUniforms.viewProjection, false, viewProjection)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.depthMask(false)
    gl.disable(gl.CULL_FACE)

    for (const { plane, fill, outline } of planeMeshes) {
      // Either side of the pair lights the same square: the user hovered
      // "bottom", but "top" is what carries the geometry.
      const opposite = OPPOSITE[plane.id]
      const state =
        planes.selected === plane.id || planes.selected === opposite ? "selected"
        : planes.hovered === plane.id || planes.hovered === opposite ? "hovered"
        : "idle"

      // ONE colour for all three, as Onshape does. Per-axis tints made
      // the origin read as three unrelated objects; a single neutral
      // makes them read as one coordinate system, and leaves the accent
      // free to mean "this is the one you are about to pick".
      const color = state === "idle" ? PLANE_COLOR : PLANE_ACTIVE_COLOR
      const fillOpacity =
        state === "selected" ? 0.26 : state === "hovered" ? 0.2 : 0.09

      gl.uniform3f(planeUniforms.color, color[0], color[1], color[2])

      gl.uniform1f(planeUniforms.opacity, fillOpacity)
      gl.bindVertexArray(fill)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      // Just the border. No grid, no axis lines: a flat translucent
      // panel with a clean edge is what a datum plane looks like in
      // Onshape, and the ruled lines read as a wireframe texture rather
      // than as a surface.
      gl.uniform1f(planeUniforms.opacity, state === "idle" ? 0.32 : 0.85)
      gl.bindVertexArray(outline)
      gl.drawArrays(gl.LINES, 0, 8)
    }

    // The names, stamped into their planes. Drawn with the fills still
    // blended and depth still not written, so a label never occludes
    // anything — it is printed ON the surface, not standing off it.
    gl.useProgram(labelProgram)
    gl.uniformMatrix4fv(labelUniforms.viewProjection, false, viewProjection)
    gl.uniform1i(labelUniforms.text, 0)
    gl.activeTexture(gl.TEXTURE0)

    // Screen-space axes, for deciding which labels read backwards.
    const eye = camera.position
    const forward = normalized([
      camera.target[0] - eye[0], camera.target[1] - eye[1], camera.target[2] - eye[2],
    ])
    // worldUp x forward, in THAT order. The reverse yields a
    // left-handed basis, which inverts every handedness test below and
    // mirrors exactly the labels that were already correct.
    const screenRight = normalized(crossProduct([0, 0, 1], forward))
    const screenUp = crossProduct(forward, screenRight)

    for (const { plane, text, label, labelMirrored } of planeMeshes) {
      if (!text || !label || !labelMirrored) continue

      // Is this plane's face turned toward the camera?
      //
      // Project the plane's own (right, up) axes to screen and take their
      // 2D cross product. The sign is the handedness of the projected
      // frame: positive means the front face is toward us and the glyphs
      // read correctly; negative means we are looking through the back
      // and the mirrored variant is needed.
      //
      // Both axes are required. Testing `right` alone cannot resolve the
      // top plane, whose right and up are both horizontal — nothing in
      // that one axis says whether the surface is seen from above or
      // below. Read off rendered pixels; two derivations landed on the
      // wrong sign before this.
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
      gl.uniform3f(labelUniforms.color, color[0], color[1], color[2])
      gl.uniform1f(labelUniforms.opacity, active ? 1 : 0.85)
      gl.bindTexture(gl.TEXTURE_2D, text.texture)
      gl.bindVertexArray(rightReading ? label : labelMirrored)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.useProgram(planeProgram)

    // The origin last and OPAQUE: it is a solid landmark, not another
    // translucent hint. Depth writing goes back on for it alone, so the
    // sphere occludes properly instead of showing its own far side
    // through its near side.
    gl.depthMask(true)
    gl.useProgram(originProgram)
    gl.uniformMatrix4fv(originUniforms.viewProjection, false, viewProjection)
    gl.uniform3f(originUniforms.lightDirection, 0.4, 0.6, 0.7)
    // Constant on-screen size: the marker is a 2D sprite, not a world sphere.
    gl.uniform2f(
      originUniforms.viewport,
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
    )
    gl.uniform1f(
      originUniforms.pixelRadius,
      ORIGIN_PIXEL_RADIUS * devicePixelRatio,
    )
    gl.bindVertexArray(originVertexArray)
    gl.drawArrays(gl.TRIANGLES, 0, originVertexCount)

    gl.bindVertexArray(null)
    gl.depthMask(true)
    gl.enable(gl.CULL_FACE)
    gl.disable(gl.BLEND)
  }

  // --- the sketch -------------------------------------------------------
  // One DYNAMIC buffer, re-uploaded whenever the geometry changes. Unlike
  // the planes this is not fixed: the rubber band changes every mouse
  // move. Uploading is still cheap — a sketch is hundreds of vertices,
  // not the hundreds of thousands a mesh carries.
  const sketchProgram = planeProgram // same shader: flat colour lines
  const sketchVertexArray = gl.createVertexArray()
  const sketchBufferHandle = gl.createBuffer()
  if (!sketchVertexArray || !sketchBufferHandle) {
    throw new Error("could not create the sketch buffer")
  }
  gl.bindVertexArray(sketchVertexArray)
  gl.bindBuffer(gl.ARRAY_BUFFER, sketchBufferHandle)
  {
    const location = gl.getAttribLocation(sketchProgram, "aPosition")
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0)
  }
  gl.bindVertexArray(null)

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
      // Snap tolerance scales with the zoom: a fixed one would be
      // unusably sticky zoomed out and useless zoomed in.
      return snap(raw, sketch.curves, snapTolerance())
    },
  }

  /** Roughly ten screen pixels, expressed in sketch millimetres. Derived
   *  from how much world space one pixel covers at the current zoom. */
  const snapTolerance = (): number => {
    const spanPerPixel = worldPerPixel()
    return spanPerPixel * 10
  }

  const worldPerPixel = (): number => {
    const projection = camera.projection
    const distance = Math.hypot(
      camera.position[0] - camera.target[0],
      camera.position[1] - camera.target[1],
      camera.position[2] - camera.target[2],
    )
    if (projection.kind === "orthographic") return projection.height / Math.max(height, 1)
    // Perspective: the visible height at the target's depth.
    const visible = 2 * distance * Math.tan(projection.fieldOfView / 2)
    return visible / Math.max(height, 1)
  }

  /**
   * Draws the sketch: committed curves solid, the rubber band dimmer,
   * and a crosshair at the snapped cursor.
   *
   * Depth testing is OFF here. A sketch sits exactly on its plane, and
   * the plane is drawn too — at equal depth the two z-fight, and the
   * curves flicker in and out as the camera moves. Drawing the sketch
   * last with the test disabled puts it unambiguously on top, which is
   * also what the user expects: you are drawing ON the plane, so your
   * lines are never hidden by it.
   */
  const drawSketch = (viewProjection: Matrix): void => {
    if (!sketch.frame) return

    const committed = sketch.curves
    const pending = sketch.pending
    const cursor = sketch.cursor

    if (committed.length === 0 && !pending && !cursor) return

    gl.useProgram(sketchProgram)
    gl.uniformMatrix4fv(planeUniforms.viewProjection, false, viewProjection)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    gl.bindVertexArray(sketchVertexArray)
    gl.bindBuffer(gl.ARRAY_BUFFER, sketchBufferHandle)

    const drawBatch = (
      curves: readonly SketchCurve[],
      color: readonly [number, number, number],
      opacity: number,
    ): void => {
      if (curves.length === 0) return
      const data = sketchBuffer(sketch.frame!, curves)
      if (data.length === 0) return
      // DYNAMIC_DRAW: this is re-uploaded on every cursor move while a
      // rubber band is live, which is exactly the access pattern the
      // hint exists for.
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
      gl.uniform3f(planeUniforms.color, color[0], color[1], color[2])
      gl.uniform1f(planeUniforms.opacity, opacity)
      gl.drawArrays(gl.LINES, 0, data.length / 3)
    }

    drawBatch(committed, SKETCH_COLOR, 1)
    // The rubber band is dimmer: it is a proposal, not yet geometry.
    if (pending) drawBatch([pending], SKETCH_PENDING_COLOR, 0.85)
    if (cursor) {
      drawBatch(
        [{ kind: "point", at: cursor }],
        sketch.snappedTo ? SKETCH_SNAP_COLOR : SKETCH_CURSOR_COLOR,
        1,
      )
    }

    gl.bindVertexArray(null)
    gl.enable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
  }

  return {
    camera,
    highlight,
    drawables,
    planes,
    sketch,

    upload(body, buffer) {
      // Replacing a body: release the old buffers first, or every
      // regeneration leaks a full mesh.
      const previous = meshes.get(body)
      if (previous) releaseMesh(gl, previous)

      const mesh = decodeMesh(buffer)
      const gpu = uploadMesh(gl, program, mesh)
      meshes.set(body, gpu)

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
      if (mesh) releaseMesh(gl, mesh)
      meshes.delete(body)
      drawables.delete(body)
    },

    clear() {
      for (const mesh of meshes.values()) releaseMesh(gl, mesh)
      meshes.clear()
      drawables.clear()
    },

    render() {
      // Advance any view-cube transition before the matrix is built, or
      // the frame would draw the camera's previous pose.
      //
      // Timed off the wall clock rather than counting frames: at 30fps a
      // per-frame step would take twice as long as at 60, and the
      // transition would visibly drag on a slower machine.
      const now = performance.now()
      const deltaSeconds = lastFrameAt === null ? 0 : (now - lastFrameAt) / 1000
      lastFrameAt = now
      // Clamped: a backgrounded tab resumes with a delta of many seconds,
      // which would teleport the camera past its target in one step.
      camera.advance(Math.min(deltaSeconds, 0.1))

      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

      const frameViewProjection = camera.viewProjection(width / height)

      if (drawables.size === 0) {
        // No body yet — but the planes may still be on, and on an empty
        // model they are the ONLY thing to draw. Returning early here is
        // what would leave a draft with nothing to click.
        drawPlanes(frameViewProjection)
        drawSketch(frameViewProjection)
        return
      }

      gl.useProgram(program)
      const viewProjection = frameViewProjection
      gl.uniformMatrix4fv(uniforms.viewProjection, false, viewProjection)
      gl.uniform3f(uniforms.lightDirection, 0.4, 0.6, 0.7)

      for (const [body, drawable] of drawables) {
        if (!drawable.visible) continue
        const mesh = meshes.get(body)
        if (!mesh) continue

        // Highlight layers answer different questions, so they must
        // stay distinguishable: hovered, selected, and everything else.
        const color = highlight.selected.has(body as never)
          ? SELECTED_COLOR
          : highlight.hovered === (body as never)
            ? HOVER_COLOR
            : drawable.appearance.color

        gl.uniformMatrix4fv(uniforms.model, false, drawable.transform as Float32Array)
        gl.uniform3f(uniforms.color, color[0], color[1], color[2])

        gl.bindVertexArray(mesh.vertexArray)
        gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0)
      }
      gl.bindVertexArray(null)

      // After the solids: translucent geometry has to blend against
      // what is already there. The sketch goes last of all — it draws on
      // top of everything, including its own plane.
      drawPlanes(viewProjection)
      drawSketch(viewProjection)
    },

    resize(nextWidth, nextHeight, devicePixelRatio) {
      width = nextWidth
      height = nextHeight
      // Backing store in device pixels: a CAD viewport at half
      // resolution reads as low quality rather than as a setting.
      backend.canvas.width = Math.round(nextWidth * devicePixelRatio)
      backend.canvas.height = Math.round(nextHeight * devicePixelRatio)
    },

    dispose() {
      for (const mesh of meshes.values()) releaseMesh(gl, mesh)
      meshes.clear()
      drawables.clear()
      for (const { fill, outline, label, labelMirrored, text } of planeMeshes) {
        gl.deleteVertexArray(fill)
        gl.deleteVertexArray(outline)
        if (label) gl.deleteVertexArray(label)
        if (labelMirrored) gl.deleteVertexArray(labelMirrored)
        if (text) gl.deleteTexture(text.texture)
      }
      gl.deleteVertexArray(originVertexArray)
      gl.deleteProgram(originProgram)
      gl.deleteProgram(labelProgram)
      gl.deleteVertexArray(sketchVertexArray)
      gl.deleteBuffer(sketchBufferHandle)
      gl.deleteProgram(planeProgram)
      gl.deleteProgram(program)
    },
  }
}

const IDENTITY = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]) as unknown as Drawable["transform"]

const HOVER_COLOR: readonly [number, number, number] = [0.44, 0.7, 1]
const SELECTED_COLOR: readonly [number, number, number] = [0.31, 0.56, 0.97]

/** All three datum planes share ONE neutral colour, as in Onshape. Tinting
 *  them per axis made the origin read as three unrelated objects instead
 *  of one coordinate system — and it spent the accent colour, which is
 *  needed to mean "this is the one you are about to pick". */
const PLANE_COLOR: readonly [number, number, number] = [0.62, 0.70, 0.82]

/** Hovered or selected. The single accent, unmistakable against the
 *  neutral the other planes keep. */
const PLANE_ACTIVE_COLOR: readonly [number, number, number] = [0.44, 0.7, 1]


/** Cap height of a plane's name, in millimetres. Roughly 7% of the
 *  plane's 120mm width — large enough to read at the default framing,
 *  small enough not to compete with the geometry. */
const LABEL_HEIGHT_MM = 6

/** Near-white: the name has to stay legible against both a lit plane and
 *  the dark space behind one, and the planes themselves are very faint. */
const LABEL_COLOR: readonly [number, number, number] = [0.96, 0.97, 1]

/** Drawn geometry is near-white: it is the subject, and everything else
 *  in the viewport is scenery. */
const SKETCH_COLOR: readonly [number, number, number] = [0.93, 0.95, 0.98]
/** The rubber band, in the accent: visibly "not yet committed". */
const SKETCH_PENDING_COLOR: readonly [number, number, number] = [0.44, 0.7, 1]
const SKETCH_CURSOR_COLOR: readonly [number, number, number] = [0.7, 0.75, 0.82]
/** A snapped cursor turns amber — the one signal that says "this click
 *  will land exactly on something", which is what makes snapping
 *  trustworthy rather than mysterious. */
const SKETCH_SNAP_COLOR: readonly [number, number, number] = [1, 0.75, 0.28]

// =====================================================================
// DATUM PLANES
// =====================================================================

/** A position-only vertex array. Planes carry no normals: they are shaded
 *  flat by design, so uploading a normal per vertex would be dead data. */
function createPlaneBuffer(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  positions: Float32Array,
): WebGLVertexArrayObject {
  const vertexArray = gl.createVertexArray()
  if (!vertexArray) throw new Error("could not create a vertex array")
  gl.bindVertexArray(vertexArray)

  const buffer = gl.createBuffer()
  if (!buffer) throw new Error("could not create a buffer")
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)

  const location = gl.getAttribLocation(program, "aPosition")
  gl.enableVertexAttribArray(location)
  gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0)

  gl.bindVertexArray(null)
  return vertexArray
}

const PLANE_VERTEX_SHADER = `#version 300 es
in vec3 aPosition;
uniform mat4 uViewProjection;

void main() {
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
}
`

const PLANE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec3 uColor;
uniform float uOpacity;

out vec4 fragColor;

void main() {
  fragColor = vec4(uColor, uOpacity);
}
`

const LABEL_VERTEX_SHADER = `#version 300 es
in vec3 aPosition;
in vec2 aTexCoord;
uniform mat4 uViewProjection;
out vec2 vTexCoord;

void main() {
  vTexCoord = aTexCoord;
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
}
`

const LABEL_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vTexCoord;
uniform sampler2D uText;
uniform vec3 uColor;
uniform float uOpacity;

out vec4 fragColor;

void main() {
  // The bitmap is white-on-transparent, so ALPHA carries the glyph and
  // the colour comes from the uniform. One texture serves every state.
  float coverage = texture(uText, vTexCoord).a;
  // Fully transparent texels are discarded rather than blended: at a
  // grazing angle the quad's empty corners would otherwise darken the
  // plane behind them into a visible rectangle.
  if (coverage < 0.01) discard;
  fragColor = vec4(uColor, coverage * uOpacity);
}
`

// On-screen radius of the origin marker, in CSS pixels (scaled by the device
// pixel ratio at draw time). Roughly the eight-across dot Onshape shows.
const ORIGIN_PIXEL_RADIUS = 5

// The origin has NO size — it is an infinitely small point in 3D space.
// aPosition is a UNIT sphere; we read its xy as a screen-space offset so the
// marker is a constant-size 2D sprite billboarded around the projected
// origin, the same pixels at every zoom (like Onshape). Only the origin
// point (0,0,0) is transformed by the camera; the sphere is inflated in
// clip space afterwards, in pixels. The normal keeps its 3D direction so the
// checker shading still reads as a round ball rather than a flat disc.
const ORIGIN_VERTEX_SHADER = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uViewProjection;
uniform vec2 uViewport;      // drawing-buffer size in pixels
uniform float uPixelRadius;  // marker radius in pixels
out vec3 vNormal;

void main() {
  vNormal = aNormal;

  // Project the origin point itself. Its clip depth anchors the marker so it
  // still occludes against the planes correctly.
  vec4 anchor = uViewProjection * vec4(0.0, 0.0, 0.0, 1.0);

  // Offset in clip space. A clip-space delta of d.xy shifts the point by
  // d.xy / uViewport * 2 in NDC after the perspective divide, so multiply by
  // anchor.w and by 2/viewport to land exactly uPixelRadius pixels out.
  vec2 offset = aPosition.xy * uPixelRadius * 2.0 / uViewport * anchor.w;
  gl_Position = vec4(anchor.xy + offset, anchor.zw);
}
`

const ORIGIN_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec3 vNormal;
uniform vec3 uLightDirection;

// The equator splits the sphere in two; three more cuts through the
// axis divide each half into four. Eight patches, alternating colour,
// and every patch is the same size — the cuts are evenly spaced in
// azimuth, so the pattern is symmetric under a quarter turn.
#define ORIGIN_MERIDIAN_COUNT 4.0

const vec3 ORIGIN_CHECKER_LIGHT = vec3(1.0, 1.0, 1.0);
const vec3 ORIGIN_CHECKER_DARK = vec3(0.55, 0.57, 0.60);

const float PI = 3.14159265359;

out vec4 fragColor;

void main() {
  vec3 normal = normalize(vNormal);
  vec3 light = normalize(uLightDirection);

  // Wrapped diffuse only, and a shallow one. No specular: a moving
  // highlight is a material cue, and this marker is not a material —
  // it is a landmark. The shading exists solely so the sphere does not
  // collapse into a flat disc, since the checker's wedges vanish at the
  // silhouette and cannot carry roundness by themselves.
  float diffuse = max(dot(normal, light) * 0.5 + 0.5, 0.0);

  // Croatian-jersey checkerboard: the equator splits top from bottom,
  // and the meridian cuts split each half into quarters. Adding the two
  // parities makes neighbours alternate across BOTH cuts, so no two
  // patches sharing an edge land on the same colour.
  //
  // Z is the polar axis here, matching how originSphere() walks its
  // rings — so the equator is the plane the top and bottom planes meet.
  float hemisphere = step(0.0, normal.z);
  float azimuth = atan(normal.y, normal.x) / (2.0 * PI) + 0.5;
  float wedge = floor(azimuth * ORIGIN_MERIDIAN_COUNT);
  float parity = mod(hemisphere + wedge, 2.0);
  vec3 base = mix(ORIGIN_CHECKER_LIGHT, ORIGIN_CHECKER_DARK, parity);

  // A narrow band: the white must still read as white and the grey as
  // grey. Shading deep enough to be obvious would make the checker's
  // two colours ambiguous, which is the opposite of what it is for.
  vec3 shaded = base * (0.78 + diffuse * 0.22);
  fragColor = vec4(shaded, 1.0);
}
`

function buildOriginProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compile(gl, gl.VERTEX_SHADER, ORIGIN_VERTEX_SHADER)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, ORIGIN_FRAGMENT_SHADER)
  const program = gl.createProgram()
  if (!program) throw new Error("could not create a program")
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`origin shader link failed: ${gl.getProgramInfoLog(program)}`)
  }
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  return program
}

/** Interleaved x,y,z,nx,ny,nz. */
function createOriginBuffer(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  data: Float32Array,
): WebGLVertexArrayObject {
  const vertexArray = gl.createVertexArray()
  if (!vertexArray) throw new Error("could not create a vertex array")
  gl.bindVertexArray(vertexArray)

  const buffer = gl.createBuffer()
  if (!buffer) throw new Error("could not create a buffer")
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)

  const stride = 6 * 4
  const position = gl.getAttribLocation(program, "aPosition")
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 3, gl.FLOAT, false, stride, 0)
  const normal = gl.getAttribLocation(program, "aNormal")
  gl.enableVertexAttribArray(normal)
  gl.vertexAttribPointer(normal, 3, gl.FLOAT, false, stride, 3 * 4)

  gl.bindVertexArray(null)
  return vertexArray
}

function buildLabelProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compile(gl, gl.VERTEX_SHADER, LABEL_VERTEX_SHADER)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, LABEL_FRAGMENT_SHADER)
  const program = gl.createProgram()
  if (!program) throw new Error("could not create a program")
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`label shader link failed: ${gl.getProgramInfoLog(program)}`)
  }
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  return program
}

/** Interleaved x,y,z,u,v — one buffer, two attributes. */
function createLabelBuffer(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  data: Float32Array,
): WebGLVertexArrayObject {
  const vertexArray = gl.createVertexArray()
  if (!vertexArray) throw new Error("could not create a vertex array")
  gl.bindVertexArray(vertexArray)

  const buffer = gl.createBuffer()
  if (!buffer) throw new Error("could not create a buffer")
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)

  const stride = 5 * 4
  const position = gl.getAttribLocation(program, "aPosition")
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 3, gl.FLOAT, false, stride, 0)
  const texCoord = gl.getAttribLocation(program, "aTexCoord")
  gl.enableVertexAttribArray(texCoord)
  gl.vertexAttribPointer(texCoord, 2, gl.FLOAT, false, stride, 3 * 4)

  gl.bindVertexArray(null)
  return vertexArray
}

function buildPlaneProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compile(gl, gl.VERTEX_SHADER, PLANE_VERTEX_SHADER)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, PLANE_FRAGMENT_SHADER)

  const program = gl.createProgram()
  if (!program) throw new Error("could not create a program")
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`plane shader link failed: ${gl.getProgramInfoLog(program)}`)
  }

  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  return program
}

// =====================================================================
// GPU RESOURCES
// =====================================================================

function uploadMesh(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  mesh: ReturnType<typeof decodeMesh>,
): GpuMesh {
  const vertexArray = gl.createVertexArray()
  if (!vertexArray) throw new Error("could not create a vertex array")
  gl.bindVertexArray(vertexArray)

  const positions = createBuffer(gl, gl.ARRAY_BUFFER, mesh.positions)
  const positionLocation = gl.getAttribLocation(program, "aPosition")
  gl.enableVertexAttribArray(positionLocation)
  gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0)

  const normals = createBuffer(gl, gl.ARRAY_BUFFER, mesh.normals)
  const normalLocation = gl.getAttribLocation(program, "aNormal")
  gl.enableVertexAttribArray(normalLocation)
  gl.vertexAttribPointer(normalLocation, 3, gl.FLOAT, false, 0, 0)

  const indices = createBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, mesh.indices)

  gl.bindVertexArray(null)

  return { positions, normals, indices, indexCount: mesh.indices.length, vertexArray }
}

function createBuffer(
  gl: WebGL2RenderingContext,
  target: number,
  data: Float32Array | Uint32Array,
): WebGLBuffer {
  const buffer = gl.createBuffer()
  if (!buffer) throw new Error("could not create a buffer")
  gl.bindBuffer(target, buffer)
  gl.bufferData(target, data, gl.STATIC_DRAW)
  return buffer
}

function releaseMesh(gl: WebGL2RenderingContext, mesh: GpuMesh): void {
  gl.deleteBuffer(mesh.positions)
  gl.deleteBuffer(mesh.normals)
  gl.deleteBuffer(mesh.indices)
  gl.deleteVertexArray(mesh.vertexArray)
}

// =====================================================================
// SHADERS
// =====================================================================
// Deliberately plain. A CAD viewport wants form to read clearly, not a
// physically based render: matte shading with a soft fill makes edges
// and curvature legible, which is what the user is actually judging.

const VERTEX_SHADER = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;

uniform mat4 uViewProjection;
uniform mat4 uModel;

out vec3 vNormal;

void main() {
  vNormal = mat3(uModel) * aNormal;
  gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
}
`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec3 vNormal;

uniform vec3 uColor;
uniform vec3 uLightDirection;

out vec4 fragColor;

void main() {
  vec3 normal = normalize(vNormal);
  vec3 light = normalize(uLightDirection);

  // Wrapped diffuse: keeps back-facing surfaces readable instead of
  // dropping them to black, which matters when inspecting a pocket.
  float diffuse = max(dot(normal, light) * 0.5 + 0.5, 0.0);
  float fill = 0.25;

  fragColor = vec4(uColor * (diffuse * 0.85 + fill), 1.0);
}
`

function buildProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)

  const program = gl.createProgram()
  if (!program) throw new Error("could not create a program")
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    throw new Error(`shader link failed: ${log}`)
  }

  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  return program
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error("could not create a shader")
  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    throw new Error(`shader compile failed: ${log}`)
  }
  return shader
}
