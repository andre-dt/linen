// =====================================================================
// packages/viewer/engine/engine-gl.ts — THE WEBGL2 DRAWING ENGINE.
//
// The WebGL2 implementation of DrawEngine. It holds one program per
// Pipeline, translates each pipeline's baked state into the imperative
// enable/disable/depthMask calls WebGL needs, and drives the HTML-in-Canvas
// label path with `texElementImage2D`. Everything WebGL-specific — VAOs,
// attribute locations, uniform locations, global state toggling — is
// contained here; the scene above sees only the DrawEngine contract.
//
// Shaders are the ones proven in the previous scene.ts / cube-scene.ts, now
// owned centrally so both the main scene and the cube share exactly one
// copy of each.
// =====================================================================

import type {
  DrawEngine, DrawCall, FramePass, MeshHandle, LabelHandle,
  VertexLayout, Pipeline, DrawUniforms,
} from "./engine"
import { FLOATS_PER_VERTEX } from "./engine"
import type { LabelStyleToken } from "./label-style"
import {
  createLabelElement, driveLabelUploads, type LabelElement,
} from "./label-texture"
import type { Matrix } from "../math"

// =====================================================================
// 1. SHADERS — one pair per pipeline
// =====================================================================
// Transcribed verbatim from the shipping scene.ts and cube-scene.ts, so
// nothing regresses as those inline copies retire.

const FLAT_VS = `#version 300 es
in vec3 aPosition;
uniform mat4 uViewProjection;
uniform mat4 uModel;
void main() { gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0); }`

const FLAT_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
out vec4 fragColor;
void main() { fragColor = vec4(uColor, uOpacity); }`

const LIT_VS = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uViewProjection;
uniform mat4 uModel;
out vec3 vNormal;
void main() {
  vNormal = mat3(uModel) * aNormal;
  gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
}`

const LIT_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
uniform vec3 uColor;
uniform vec3 uLightDirection;
out vec4 fragColor;
void main() {
  vec3 normal = normalize(vNormal);
  vec3 light = normalize(uLightDirection);
  float diffuse = max(dot(normal, light) * 0.5 + 0.5, 0.0);
  float fill = 0.25;
  fragColor = vec4(uColor * (diffuse * 0.85 + fill), 1.0);
}`

const LABEL_VS = `#version 300 es
in vec3 aPosition;
in vec2 aTexCoord;
uniform mat4 uViewProjection;
uniform mat4 uModel;
out vec2 vTexCoord;
void main() {
  vTexCoord = aTexCoord;
  gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
}`

const LABEL_FS = `#version 300 es
precision highp float;
in vec2 vTexCoord;
uniform sampler2D uText;
uniform vec3 uColor;
uniform float uOpacity;
out vec4 fragColor;
void main() {
  float coverage = texture(uText, vTexCoord).a;
  if (coverage < 0.01) discard;
  fragColor = vec4(uColor, coverage * uOpacity);
}`

// The cube face composites its label OVER a flat tinted plate (rather than
// discarding around the glyphs like the plane label), and brightens while
// hovered. UVs outside [0,1] carry no label.
const CUBE_VS = `#version 300 es
in vec3 aPosition;
in vec2 aTexCoord;
uniform mat4 uViewProjection;
uniform mat4 uModel;
out vec2 vUv;
void main() {
  vUv = aTexCoord;
  gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
}`

const CUBE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uColor;
uniform float uHighlighted;
uniform float uLabelled;
uniform sampler2D uText;
out vec4 fragColor;
void main() {
  vec3 shade = mix(uColor, vec3(0.42, 0.62, 0.95), uHighlighted * 0.65);
  float inBounds = (vUv.x >= 0.0 && vUv.x <= 1.0 && vUv.y >= 0.0 && vUv.y <= 1.0)
    ? 1.0 : 0.0;
  float coverage = texture(uText, vUv).a;
  float mask = uLabelled * inBounds * coverage;
  shade = mix(shade, vec3(0.82, 0.87, 0.96), mask);
  fragColor = vec4(shade, 1.0);
}`

const ORIGIN_VS = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uViewProjection;
uniform vec2 uViewport;
uniform float uPixelRadius;
out vec3 vNormal;
void main() {
  vNormal = aNormal;
  vec4 anchor = uViewProjection * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 offset = aPosition.xy * uPixelRadius * 2.0 / uViewport * anchor.w;
  gl_Position = vec4(anchor.xy + offset, anchor.zw);
}`

const ORIGIN_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
uniform vec3 uLightDirection;
#define ORIGIN_MERIDIAN_COUNT 4.0
const vec3 ORIGIN_CHECKER_LIGHT = vec3(1.0, 1.0, 1.0);
const vec3 ORIGIN_CHECKER_DARK = vec3(0.55, 0.57, 0.60);
const float PI = 3.14159265359;
out vec4 fragColor;
void main() {
  vec3 normal = normalize(vNormal);
  vec3 light = normalize(uLightDirection);
  float diffuse = max(dot(normal, light) * 0.5 + 0.5, 0.0);
  float hemisphere = step(0.0, normal.z);
  float azimuth = atan(normal.y, normal.x) / (2.0 * PI) + 0.5;
  float wedge = floor(azimuth * ORIGIN_MERIDIAN_COUNT);
  float parity = mod(hemisphere + wedge, 2.0);
  vec3 base = mix(ORIGIN_CHECKER_LIGHT, ORIGIN_CHECKER_DARK, parity);
  vec3 shaded = base * (0.78 + diffuse * 0.22);
  fragColor = vec4(shaded, 1.0);
}`

// =====================================================================
// 2. PIPELINE DEFINITIONS — shader source + baked state, per pipeline
// =====================================================================

/** The state a Pipeline bakes, applied imperatively per draw. */
interface GlPipelineState {
  readonly vertex: string
  readonly fragment: string
  readonly layout: VertexLayout
  readonly primitive: "triangles" | "lines"
  readonly depthTest: boolean
  readonly depthWrite: boolean
  readonly cull: boolean
  readonly blend: boolean
  /** Samples a label texture on unit 0. */
  readonly textured: boolean
}

const PIPELINES: Record<Pipeline, GlPipelineState> = {
  "lit-mesh": {
    vertex: LIT_VS, fragment: LIT_FS, layout: "position-normal",
    primitive: "triangles", depthTest: true, depthWrite: true, cull: true,
    blend: false, textured: false,
  },
  "flat-fill": {
    vertex: FLAT_VS, fragment: FLAT_FS, layout: "position",
    primitive: "triangles", depthTest: true, depthWrite: false, cull: false,
    blend: true, textured: false,
  },
  "flat-line": {
    vertex: FLAT_VS, fragment: FLAT_FS, layout: "position",
    primitive: "lines", depthTest: true, depthWrite: false, cull: false,
    blend: true, textured: false,
  },
  "sketch-line": {
    vertex: FLAT_VS, fragment: FLAT_FS, layout: "position",
    primitive: "lines", depthTest: false, depthWrite: false, cull: false,
    blend: true, textured: false,
  },
  "label": {
    vertex: LABEL_VS, fragment: LABEL_FS, layout: "position-uv",
    primitive: "triangles", depthTest: true, depthWrite: false, cull: false,
    blend: true, textured: true,
  },
  "origin-billboard": {
    vertex: ORIGIN_VS, fragment: ORIGIN_FS, layout: "position-normal",
    primitive: "triangles", depthTest: true, depthWrite: true, cull: false,
    blend: false, textured: false,
  },
  "cube-face": {
    vertex: CUBE_VS, fragment: CUBE_FS, layout: "position-uv",
    primitive: "triangles", depthTest: true, depthWrite: true, cull: true,
    blend: false, textured: true,
  },
}

// =====================================================================
// 3. INTERNAL RESOURCE TYPES
// =====================================================================

interface GlProgram {
  readonly program: WebGLProgram
  readonly uniforms: Record<string, WebGLUniformLocation | null>
}

interface GlMesh {
  readonly vertexArray: WebGLVertexArrayObject
  readonly vertexBuffer: WebGLBuffer
  readonly indexBuffer: WebGLBuffer | null
  readonly capacityVertices: number
}

interface GlLabel {
  texture: WebGLTexture
  readonly dom: LabelElement
}

const IDENTITY: Matrix = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]) as unknown as Matrix

/** The subset of the HTML-in-Canvas WebGL method we call. Declared here
 *  because the ambient lib types do not ship it yet (it rides a flag). */
type TexElementImage2D = (
  target: number, internalformat: number, element: Element,
) => void

// =====================================================================
// 4. THE ENGINE
// =====================================================================

export type CreateGlEngine = (
  canvas: HTMLCanvasElement,
  gl: WebGL2RenderingContext,
) => DrawEngine

export const createGlEngine: CreateGlEngine = (canvas, gl) => {
  // Labels are HTML children of the canvas; the API needs this opt-in to
  // lay them out and read their pixels.
  canvas.setAttribute("layoutsubtree", "")

  // --- program compilation, one per pipeline (lazily shared) ----------
  const programs = new Map<Pipeline, GlProgram>()

  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error(`shader compile failed: ${log}`)
    }
    return shader
  }

  const UNIFORM_NAMES = [
    "uViewProjection", "uModel", "uColor", "uOpacity", "uLightDirection",
    "uViewport", "uPixelRadius", "uHighlighted", "uLabelled", "uText",
  ]

  const programFor = (pipeline: Pipeline): GlProgram => {
    const cached = programs.get(pipeline)
    if (cached) return cached
    const spec = PIPELINES[pipeline]
    const program = gl.createProgram()!
    const vs = compile(gl.VERTEX_SHADER, spec.vertex)
    const fs = compile(gl.FRAGMENT_SHADER, spec.fragment)
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    // Fix attribute locations BEFORE link so a VAO built with the same
    // layout draws under any program. aPosition is always 0; the second
    // attribute (aNormal or aTexCoord, whichever the shader declares) is 1.
    gl.bindAttribLocation(program, 0, "aPosition")
    gl.bindAttribLocation(program, 1, "aNormal")
    gl.bindAttribLocation(program, 1, "aTexCoord")
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`)
    }
    const uniforms: Record<string, WebGLUniformLocation | null> = {}
    for (const name of UNIFORM_NAMES) {
      uniforms[name] = gl.getUniformLocation(program, name)
    }
    const built: GlProgram = { program, uniforms }
    programs.set(pipeline, built)
    return built
  }

  // --- vertex attribute wiring, by layout -----------------------------
  // Locations are fixed across all programs by bindAttribLocation in
  // programFor (0 = position, 1 = normal/uv), so a VAO built once here
  // draws correctly under any pipeline sharing its layout.
  const configureAttributes = (layout: VertexLayout): void => {
    const stride = FLOATS_PER_VERTEX[layout] * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0)
    if (layout === "position-uv") {
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 3 * 4)
    } else if (layout === "position-normal") {
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4)
    }
  }

  const meshes = new Set<GlMesh>()

  const createMeshInternal = (
    data: Float32Array,
    layout: VertexLayout,
    indices: Uint32Array | null,
    capacityVertices: number,
    dynamic: boolean,
  ): MeshHandle => {
    const vertexArray = gl.createVertexArray()!
    const vertexBuffer = gl.createBuffer()!
    gl.bindVertexArray(vertexArray)
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER, data,
      dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW,
    )
    configureAttributes(layout)

    let indexBuffer: WebGLBuffer | null = null
    if (indices) {
      indexBuffer = gl.createBuffer()!
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
    }
    gl.bindVertexArray(null)

    const floats = FLOATS_PER_VERTEX[layout]
    const resource: GlMesh = {
      vertexArray, vertexBuffer, indexBuffer, capacityVertices,
    }
    meshes.add(resource)
    return {
      layout,
      vertexCount: indices ? indices.length : data.length / floats,
      indexCount: indices ? indices.length : null,
      dynamic,
      resource,
    }
  }

  // --- label path -----------------------------------------------------
  const labels = new Set<GlLabel>()
  let cancelUploads: (() => void) | null = null

  const texElementImage2D = (gl as unknown as {
    texElementImage2D?: TexElementImage2D
  }).texElementImage2D

  const copyLabel = (label: GlLabel): boolean => {
    if (typeof texElementImage2D !== "function") return false
    try {
      gl.bindTexture(gl.TEXTURE_2D, label.texture)
      texElementImage2D.call(gl, gl.TEXTURE_2D, gl.RGBA8, label.dom.element)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(
        gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR,
      )
      gl.bindTexture(gl.TEXTURE_2D, null)
      return true
    } catch {
      gl.bindTexture(gl.TEXTURE_2D, null)
      return false
    }
  }

  // Whenever new labels appear, (re)start the paint-retry loop over every
  // label that has not yet copied. Cheap: fixed words, a few frames.
  const restartUploads = (): void => {
    cancelUploads?.()
    cancelUploads = driveLabelUploads(
      [...labels], (label) => copyLabel(label as GlLabel),
    )
  }

  // --- state application ----------------------------------------------
  const applyState = (spec: GlPipelineState): void => {
    if (spec.depthTest) gl.enable(gl.DEPTH_TEST)
    else gl.disable(gl.DEPTH_TEST)
    gl.depthMask(spec.depthWrite)
    if (spec.cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK) }
    else gl.disable(gl.CULL_FACE)
    if (spec.blend) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    } else {
      gl.disable(gl.BLEND)
    }
  }

  const setUniforms = (
    program: GlProgram, spec: GlPipelineState, u: DrawUniforms,
  ): void => {
    const loc = program.uniforms
    gl.uniformMatrix4fv(
      loc.uViewProjection!, false, u.viewProjection as unknown as Float32Array,
    )
    if (loc.uModel) {
      gl.uniformMatrix4fv(
        loc.uModel, false,
        (u.model ?? IDENTITY) as unknown as Float32Array,
      )
    }
    if (loc.uColor && u.color) gl.uniform3f(loc.uColor, u.color[0], u.color[1], u.color[2])
    if (loc.uOpacity) gl.uniform1f(loc.uOpacity, u.opacity ?? 1)
    if (loc.uLightDirection && u.lightDirection) {
      gl.uniform3f(
        loc.uLightDirection,
        u.lightDirection[0], u.lightDirection[1], u.lightDirection[2],
      )
    }
    if (loc.uViewport && u.viewport) {
      gl.uniform2f(loc.uViewport, u.viewport[0], u.viewport[1])
    }
    if (loc.uPixelRadius) gl.uniform1f(loc.uPixelRadius, u.pixelRadius ?? 0)
    if (loc.uHighlighted) gl.uniform1f(loc.uHighlighted, u.highlighted ?? 0)
    if (loc.uLabelled) gl.uniform1f(loc.uLabelled, u.labelled ?? 0)
    if (spec.textured && loc.uText) gl.uniform1i(loc.uText, 0)
  }

  const engine: DrawEngine = {
    backend: "webgl2",

    createMesh(data, layout, indices) {
      return createMeshInternal(
        data, layout, indices ?? null, data.length / FLOATS_PER_VERTEX[layout],
        false,
      )
    },

    createDynamicMesh(layout, capacityVertices) {
      const empty = new Float32Array(capacityVertices * FLOATS_PER_VERTEX[layout])
      return createMeshInternal(empty, layout, null, capacityVertices, true)
    },

    updateMesh(mesh, data, vertexCount) {
      if (!mesh.dynamic) throw new Error("updateMesh on a static mesh")
      const glMesh = mesh.resource as GlMesh
      if (vertexCount > glMesh.capacityVertices) {
        throw new Error("updateMesh exceeds capacity")
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, glMesh.vertexBuffer)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
      gl.bindBuffer(gl.ARRAY_BUFFER, null)
      ;(mesh as { vertexCount: number }).vertexCount = vertexCount
    },

    destroyMesh(mesh) {
      const glMesh = mesh.resource as GlMesh
      gl.deleteVertexArray(glMesh.vertexArray)
      gl.deleteBuffer(glMesh.vertexBuffer)
      if (glMesh.indexBuffer) gl.deleteBuffer(glMesh.indexBuffer)
      meshes.delete(glMesh)
    },

    writeLabel(text, style: LabelStyleToken) {
      const dom = createLabelElement(canvas, text, style)
      const texture = gl.createTexture()!
      // Start as a 1×1 transparent pixel so a draw before the element has
      // painted samples nothing rather than failing.
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0]),
      )
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      // Anisotropy: these labels lie on surfaces seen at grazing angles.
      const aniso =
        gl.getExtension("EXT_texture_filter_anisotropic") ??
        gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic")
      if (aniso) {
        const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number
        gl.texParameterf(
          gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, max),
        )
      }
      gl.bindTexture(gl.TEXTURE_2D, null)

      const label: GlLabel = { texture, dom }
      labels.add(label)
      restartUploads()
      return { aspect: 1, resource: label }
    },

    destroyLabel(label: LabelHandle) {
      const glLabel = label.resource as GlLabel
      gl.deleteTexture(glLabel.texture)
      glLabel.dom.element.remove()
      labels.delete(glLabel)
    },

    frame(pass: FramePass, draws: readonly DrawCall[]) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      gl.clearColor(pass.clear[0], pass.clear[1], pass.clear[2], pass.clear[3])
      gl.depthMask(true)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

      let lastPipeline: Pipeline | null = null
      for (const draw of draws) {
        const spec = PIPELINES[draw.pipeline]
        const program = programFor(draw.pipeline)
        if (draw.pipeline !== lastPipeline) {
          gl.useProgram(program.program)
          applyState(spec)
          lastPipeline = draw.pipeline
        }
        setUniforms(program, spec, draw.uniforms)

        if (spec.textured) {
          const glLabel = (draw.label?.resource ?? null) as GlLabel | null
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, glLabel ? glLabel.texture : null)
        }

        const glMesh = draw.mesh.resource as GlMesh
        gl.bindVertexArray(glMesh.vertexArray)
        const mode = spec.primitive === "lines" ? gl.LINES : gl.TRIANGLES
        if (draw.mesh.indexCount != null) {
          gl.drawElements(mode, draw.mesh.indexCount, gl.UNSIGNED_INT, 0)
        } else {
          gl.drawArrays(mode, 0, draw.mesh.vertexCount)
        }
      }
      gl.bindVertexArray(null)
      if (lastPipeline && PIPELINES[lastPipeline].textured) {
        gl.bindTexture(gl.TEXTURE_2D, null)
      }
    },

    resize(width, height, dpr) {
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
    },

    dispose() {
      cancelUploads?.()
      for (const mesh of meshes) {
        gl.deleteVertexArray(mesh.vertexArray)
        gl.deleteBuffer(mesh.vertexBuffer)
        if (mesh.indexBuffer) gl.deleteBuffer(mesh.indexBuffer)
      }
      meshes.clear()
      for (const label of labels) {
        gl.deleteTexture(label.texture)
        label.dom.element.remove()
      }
      labels.clear()
      for (const { program } of programs.values()) gl.deleteProgram(program)
      programs.clear()
    },
  }

  return engine
}
