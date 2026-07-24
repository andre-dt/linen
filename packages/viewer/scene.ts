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
import { decodeMesh } from "./mesh"
import { createCamera } from "./camera"
import { matrixMultiply, type Matrix } from "./math"

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

  return {
    camera,
    highlight,
    drawables,

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

      if (drawables.size === 0) return

      gl.useProgram(program)
      const viewProjection = camera.viewProjection(width / height)
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
      gl.deleteProgram(program)
    },
  }
}

const IDENTITY = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]) as unknown as Drawable["transform"]

const HOVER_COLOR: readonly [number, number, number] = [0.44, 0.7, 1]
const SELECTED_COLOR: readonly [number, number, number] = [0.31, 0.56, 0.97]

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
