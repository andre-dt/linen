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
import type { PlaneLayer } from "./index"
import { decodeMesh } from "./mesh"
import { createCamera } from "./camera"
import { matrixMultiply, invert, type Matrix } from "./math"
import {
  DATUM_PLANES, planeQuad, planeOutline, pickPlane, rayThrough,
  type DatumPlane, type DatumPlaneId,
} from "./planes"

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
  const planeMeshes = DATUM_PLANES.map((plane) => ({
    plane,
    fill: createPlaneBuffer(gl, planeProgram, planeQuad(plane)),
    outline: createPlaneBuffer(gl, planeProgram, planeOutline(plane)),
  }))

  const planes: PlaneLayer = {
    visible: false,
    hovered: null,
    selected: null,

    pick(x, y) {
      const inverse = invert(camera.viewProjection(width / height))
      // A singular view-projection means the camera is degenerate; no
      // ray can be built from it, so nothing is hit.
      if (!inverse) return null
      return pickPlane(rayThrough(x, y, width, height, inverse))
    },
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
      const state =
        planes.selected === plane.id ? "selected"
        : planes.hovered === plane.id ? "hovered"
        : "idle"

      const color =
        state === "idle" ? plane.color : PLANE_ACTIVE_COLOR
      // Faint at rest so six overlapping planes do not read as fog;
      // clearly lit under the cursor and once chosen.
      const fillOpacity =
        state === "selected" ? 0.3 : state === "hovered" ? 0.22 : 0.08

      gl.uniform3f(planeUniforms.color, color[0], color[1], color[2])

      gl.uniform1f(planeUniforms.opacity, fillOpacity)
      gl.bindVertexArray(fill)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      // The border carries the plane's identity — the fill is too faint
      // to read as a shape on its own.
      gl.uniform1f(planeUniforms.opacity, state === "idle" ? 0.45 : 0.95)
      gl.bindVertexArray(outline)
      gl.drawArrays(gl.LINES, 0, 8)
    }

    gl.bindVertexArray(null)
    gl.depthMask(true)
    gl.enable(gl.CULL_FACE)
    gl.disable(gl.BLEND)
  }

  return {
    camera,
    highlight,
    drawables,
    planes,

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
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

      const frameViewProjection = camera.viewProjection(width / height)

      if (drawables.size === 0) {
        // No body yet — but the planes may still be on, and on an empty
        // model they are the ONLY thing to draw. Returning early here is
        // what would leave a draft with nothing to click.
        drawPlanes(frameViewProjection)
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
      // what is already there.
      drawPlanes(viewProjection)
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
      for (const { fill, outline } of planeMeshes) {
        gl.deleteVertexArray(fill)
        gl.deleteVertexArray(outline)
      }
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

/** Hovered or selected planes drop their axis tint for one shared accent:
 *  "this is the one" has to be unmistakable, and three different tints
 *  lighting up would not read as the same state. */
const PLANE_ACTIVE_COLOR: readonly [number, number, number] = [0.44, 0.7, 1]

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
