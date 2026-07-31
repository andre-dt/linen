// =====================================================================
// packages/viewer/engine/engine-gpu.ts — THE WEBGPU DRAWING ENGINE.
//
// The WebGPU implementation of DrawEngine. Each Pipeline is a baked
// GPURenderPipeline; per-draw parameters ride a single dynamic-offset
// uniform buffer; MSAA is a native multisampled colour target that
// resolves into the canvas. The HTML-in-Canvas label path uses
// `copyElementImageToTexture` plus a small mip-generation blit — the WebGPU
// analog of the WebGL `texElementImage2D` path, kept behind the same
// `writeLabel` contract.
//
// DEPTH CONVENTION
// ----------------
// math.ts builds GL-style projections (z in [-1, 1]); WebGPU wants [0, 1].
// Every incoming viewProjection is pre-multiplied by GL_TO_WEBGPU_DEPTH
// here, so the scene never has to know which backend it drew under.
// =====================================================================

import type {
  DrawEngine, DrawCall, FramePass, MeshHandle, LabelHandle,
  VertexLayout, Pipeline, DrawUniforms,
} from "./engine"
import { FLOATS_PER_VERTEX } from "./engine"
import type { LabelStyleToken } from "./label-style"
import {
  createLabelElement, driveLabelUploads, mipLevelsFor, type LabelElement,
} from "./label-texture"
import { matrixMultiply, type Matrix } from "../math"

// =====================================================================
// 1. SHADERS — WGSL, one module per pipeline family
// =====================================================================
// Ported from the GLSL in engine-gl.ts / the shipping scene, adapted to
// WGSL. Each takes the same per-draw uniform struct so packing is uniform.

/** The per-draw uniform block, shared by every pipeline. Laid out to WGSL
 *  std140-ish rules; see PART_FLOATS for the byte map. */
const UNIFORM_STRUCT = /* wgsl */ `
struct Draw {
  viewProjection : mat4x4<f32>,   //   0..63
  model          : mat4x4<f32>,   //  64..127
  color          : vec3<f32>,     // 128..139
  opacity        : f32,           // 140
  lightDirection : vec3<f32>,     // 144..155
  pixelRadius    : f32,           // 156
  viewport       : vec2<f32>,     // 160..167
  highlighted    : f32,           // 168
  labelled       : f32,           // 172
};
@group(0) @binding(0) var<uniform> draw : Draw;
`

const FLAT_SHADER = /* wgsl */ `
${UNIFORM_STRUCT}
@vertex fn vs(@location(0) position : vec3<f32>) -> @builtin(position) vec4<f32> {
  return draw.viewProjection * draw.model * vec4<f32>(position, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(draw.color, draw.opacity);
}
`

const LIT_SHADER = /* wgsl */ `
${UNIFORM_STRUCT}
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) normal : vec3<f32> };
@vertex fn vs(@location(0) position : vec3<f32>, @location(1) normal : vec3<f32>) -> VSOut {
  var out : VSOut;
  out.normal = (draw.model * vec4<f32>(normal, 0.0)).xyz;
  out.pos = draw.viewProjection * draw.model * vec4<f32>(position, 1.0);
  return out;
}
@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let l = normalize(draw.lightDirection);
  let diffuse = max(dot(n, l) * 0.5 + 0.5, 0.0);
  return vec4<f32>(draw.color * (diffuse * 0.85 + 0.25), 1.0);
}
`

const LABEL_SHADER = /* wgsl */ `
${UNIFORM_STRUCT}
@group(1) @binding(0) var labelSampler : sampler;
@group(1) @binding(1) var labelTexture : texture_2d<f32>;
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) position : vec3<f32>, @location(1) uv : vec2<f32>) -> VSOut {
  var out : VSOut;
  out.uv = uv;
  out.pos = draw.viewProjection * draw.model * vec4<f32>(position, 1.0);
  return out;
}
@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let coverage = textureSample(labelTexture, labelSampler, in.uv).a;
  if (coverage < 0.01) { discard; }
  return vec4<f32>(draw.color, coverage * draw.opacity);
}
`

const CUBE_SHADER = /* wgsl */ `
${UNIFORM_STRUCT}
@group(1) @binding(0) var labelSampler : sampler;
@group(1) @binding(1) var labelTexture : texture_2d<f32>;
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) position : vec3<f32>, @location(1) uv : vec2<f32>) -> VSOut {
  var out : VSOut;
  out.uv = uv;
  out.pos = draw.viewProjection * draw.model * vec4<f32>(position, 1.0);
  return out;
}
@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> {
  var shade = mix(draw.color, vec3<f32>(0.42, 0.62, 0.95), draw.highlighted * 0.65);
  let coverage = textureSample(labelTexture, labelSampler, in.uv).a;
  let inBounds = f32(in.uv.x >= 0.0 && in.uv.x <= 1.0 && in.uv.y >= 0.0 && in.uv.y <= 1.0);
  let mask = draw.labelled * inBounds * coverage;
  shade = mix(shade, vec3<f32>(0.82, 0.87, 0.96), mask);
  return vec4<f32>(shade, 1.0);
}
`

// The origin sprite: one quad, placed in screen space around the projected
// origin so it holds a fixed pixel size and always faces the viewer. The
// fragment cuts a flat disc out of it — unlit, because the origin is a
// point with no surface. See originSprite in planes.ts.
const ORIGIN_SHADER = /* wgsl */ `
${UNIFORM_STRUCT}
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) position : vec3<f32>, @location(1) uv : vec2<f32>) -> VSOut {
  var out : VSOut;
  out.uv = uv;
  let anchor = draw.viewProjection * vec4<f32>(0.0, 0.0, 0.0, 1.0);
  let offset = position.xy * draw.pixelRadius * 2.0 / draw.viewport * anchor.w;
  out.pos = vec4<f32>(anchor.xy + offset, anchor.zw);
  return out;
}
// A solid centre dot, a gap, then a thin ring at the rim — see the
// matching ORIGIN_FS in engine-gl.ts for why the reticle is shaped this
// way. Radii are fractions of the sprite's half-extent; dot and ring
// combine with max() so an overlap never doubles into a bright seam.
const ORIGIN_DOT_RADIUS = 0.26;
const ORIGIN_RING_RADIUS = 0.82;
const ORIGIN_RING_WIDTH = 0.13;
@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let distance = length(in.uv);
  let feather = 1.0 / max(draw.pixelRadius, 1.0);

  let centre = 1.0 - smoothstep(
    ORIGIN_DOT_RADIUS - feather, ORIGIN_DOT_RADIUS + feather, distance);

  let halfWidth = ORIGIN_RING_WIDTH * 0.5;
  let ring =
    smoothstep(ORIGIN_RING_RADIUS - halfWidth - feather,
               ORIGIN_RING_RADIUS - halfWidth + feather, distance) *
    (1.0 - smoothstep(ORIGIN_RING_RADIUS + halfWidth - feather,
                      ORIGIN_RING_RADIUS + halfWidth + feather, distance));

  let coverage = max(centre, ring);
  if (coverage <= 0.0) { discard; }
  return vec4<f32>(draw.color, draw.opacity * coverage);
}
`

// The mip-generation blit — fills every level below 0 from the one above.
const MIP_SHADER = /* wgsl */ `
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var samp : sampler;
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i : u32) -> VSOut {
  var p = array<vec2<f32>,3>(vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
  var out : VSOut;
  let xy = p[i];
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
  return out;
}
@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> {
  return textureSample(src, samp, in.uv);
}
`

// =====================================================================
// 2. CONSTANTS
// =====================================================================

const SAMPLE_COUNT = 4
const PART_STRIDE = 256           // dynamic-offset alignment
const PART_FLOATS = PART_STRIDE / 4
const UNIFORM_RING = 512          // draw calls per frame the ring holds

/** GL clip z [-1,1] -> WebGPU [0,1]. Column-major, matching math.ts. */
const GL_TO_WEBGPU_DEPTH: Matrix = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0.5, 0,
  0, 0, 0.5, 1,
]) as Matrix

const IDENTITY: Matrix = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]) as Matrix

interface GpuPipelineState {
  readonly shader: string
  readonly layout: VertexLayout
  readonly topology: GPUPrimitiveTopology
  readonly depthWrite: boolean
  readonly depthCompare: GPUCompareFunction
  readonly cull: GPUCullMode
  readonly blend: boolean
  readonly textured: boolean
}

const PIPELINES: Record<Pipeline, GpuPipelineState> = {
  "lit-mesh": {
    shader: LIT_SHADER, layout: "position-normal", topology: "triangle-list",
    depthWrite: true, depthCompare: "less", cull: "back", blend: false,
    textured: false,
  },
  "flat-fill": {
    shader: FLAT_SHADER, layout: "position", topology: "triangle-list",
    depthWrite: false, depthCompare: "less", cull: "none", blend: true,
    textured: false,
  },
  "flat-line": {
    shader: FLAT_SHADER, layout: "position", topology: "line-list",
    depthWrite: false, depthCompare: "less", cull: "none", blend: true,
    textured: false,
  },
  "sketch-line": {
    shader: FLAT_SHADER, layout: "position", topology: "line-list",
    depthWrite: false, depthCompare: "always", cull: "none", blend: true,
    textured: false,
  },
  "label": {
    shader: LABEL_SHADER, layout: "position-uv", topology: "triangle-list",
    depthWrite: false, depthCompare: "less", cull: "none", blend: true,
    textured: true,
  },
  "origin-billboard": {
    shader: ORIGIN_SHADER, layout: "position-uv", topology: "triangle-list",
    depthWrite: false, depthCompare: "less", cull: "none", blend: true,
    textured: false,
  },
  "cube-face": {
    shader: CUBE_SHADER, layout: "position-uv", topology: "triangle-list",
    depthWrite: true, depthCompare: "less", cull: "back", blend: false,
    textured: true,
  },
}

const VERTEX_ATTRS: Record<VertexLayout, GPUVertexAttribute[]> = {
  "position": [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
  "position-uv": [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "float32x2" },
  ],
  "position-normal": [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "float32x3" },
  ],
}

// =====================================================================
// 3. INTERNAL RESOURCE TYPES
// =====================================================================

interface GpuMesh {
  readonly vertexBuffer: GPUBuffer
  readonly indexBuffer: GPUBuffer | null
  readonly capacityVertices: number
  readonly layout: VertexLayout
}

interface GpuLabel {
  readonly texture: GPUTexture
  view: GPUTextureView
  readonly mipLevelCount: number
  readonly dom: LabelElement
}

type CopyElementImageToTexture = (
  source: { source: Element },
  destination: { destination: GPUImageCopyTexture; width: number; height: number },
) => void

// =====================================================================
// 4. THE ENGINE
// =====================================================================

export type CreateGpuEngine = (
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  context: GPUCanvasContext,
  format: GPUTextureFormat,
) => DrawEngine

export const createGpuEngine: CreateGpuEngine = (
  canvas, device, context, format,
) => {
  canvas.setAttribute("layoutsubtree", "")

  // writeBuffer wants a BufferSource; the ambient typed-array generics don't
  // narrow to it cleanly, so this one cast lives here rather than at each call.
  const write = (
    buffer: GPUBuffer, offset: number, data: Float32Array | Uint32Array,
  ): void => device.queue.writeBuffer(buffer, offset, data as BufferSource)

  const shaderModules = new Map<string, GPUShaderModule>()
  const moduleFor = (code: string): GPUShaderModule => {
    const cached = shaderModules.get(code)
    if (cached) return cached
    const made = device.createShaderModule({ code })
    shaderModules.set(code, made)
    return made
  }

  // --- bind group layouts ---------------------------------------------
  const drawLayout = device.createBindGroupLayout({
    entries: [{
      binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: PART_STRIDE },
    }],
  })
  const textureLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ],
  })

  // --- pipelines ------------------------------------------------------
  const pipelines = new Map<Pipeline, GPURenderPipeline>()
  const pipelineFor = (name: Pipeline): GPURenderPipeline => {
    const cached = pipelines.get(name)
    if (cached) return cached
    const spec = PIPELINES[name]
    const module = moduleFor(spec.shader)
    const built = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: spec.textured ? [drawLayout, textureLayout] : [drawLayout],
      }),
      vertex: {
        module, entryPoint: "vs",
        buffers: [{
          arrayStride: FLOATS_PER_VERTEX[spec.layout] * 4,
          attributes: VERTEX_ATTRS[spec.layout],
        }],
      },
      fragment: {
        module, entryPoint: "fs",
        targets: [
          spec.blend
            ? {
                format,
                blend: {
                  color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                  alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                },
              }
            : { format },
        ],
      },
      primitive: { topology: spec.topology, cullMode: spec.cull, frontFace: "ccw" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: spec.depthWrite,
        depthCompare: spec.depthCompare,
      },
      multisample: { count: SAMPLE_COUNT },
    })
    pipelines.set(name, built)
    return built
  }

  // --- uniform ring + sampler -----------------------------------------
  // One dynamic-offset uniform buffer holding every draw's block for a
  // frame. Sized for a generous default and GROWN (never silently capped)
  // if a frame ever exceeds it, so a heavy model does not drop draws.
  let uniformCapacity = UNIFORM_RING
  let uniformBuffer = device.createBuffer({
    size: PART_STRIDE * uniformCapacity,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  let drawBindGroup = device.createBindGroup({
    layout: drawLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer, offset: 0, size: PART_STRIDE } }],
  })
  const ensureUniformCapacity = (count: number): void => {
    if (count <= uniformCapacity) return
    let next = uniformCapacity
    while (next < count) next *= 2
    uniformBuffer.destroy()
    uniformCapacity = next
    uniformBuffer = device.createBuffer({
      size: PART_STRIDE * uniformCapacity,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    drawBindGroup = device.createBindGroup({
      layout: drawLayout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer, offset: 0, size: PART_STRIDE } }],
    })
  }
  const sampler = device.createSampler({
    magFilter: "linear", minFilter: "linear", mipmapFilter: "linear",
    maxAnisotropy: 16, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
  })
  const blankTexture = device.createTexture({
    size: [1, 1], format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture(
    { texture: blankTexture }, new Uint8Array([0, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1],
  )
  const blankView = blankTexture.createView()

  const textureBindGroupFor = (view: GPUTextureView): GPUBindGroup =>
    device.createBindGroup({
      layout: textureLayout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: view },
      ],
    })
  const blankBindGroup = textureBindGroupFor(blankView)

  // --- resource registries --------------------------------------------
  const meshes = new Set<GpuMesh>()
  const labels = new Set<GpuLabel>()
  let cancelUploads: (() => void) | null = null

  // --- MSAA + depth targets -------------------------------------------
  let msaaTexture: GPUTexture | null = null
  let depthTexture: GPUTexture | null = null

  const rebuildTargets = (): void => {
    msaaTexture?.destroy()
    depthTexture?.destroy()
    const width = Math.max(1, canvas.width)
    const height = Math.max(1, canvas.height)
    msaaTexture = device.createTexture({
      size: [width, height], format, sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    depthTexture = device.createTexture({
      size: [width, height], format: "depth24plus", sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
  }

  // --- uniform packing ------------------------------------------------
  const packDraw = (target: Float32Array, base: number, u: DrawUniforms): void => {
    const vp = matrixMultiply(GL_TO_WEBGPU_DEPTH, u.viewProjection)
    target.set(vp, base + 0)
    target.set(u.model ?? IDENTITY, base + 16)
    const c = u.color ?? [1, 1, 1]
    target[base + 32] = c[0]; target[base + 33] = c[1]; target[base + 34] = c[2]
    target[base + 35] = u.opacity ?? 1
    const l = u.lightDirection ?? [0, 0, 1]
    target[base + 36] = l[0]; target[base + 37] = l[1]; target[base + 38] = l[2]
    target[base + 39] = u.pixelRadius ?? 0
    const v = u.viewport ?? [1, 1]
    target[base + 40] = v[0]; target[base + 41] = v[1]
    target[base + 42] = u.highlighted ?? 0
    target[base + 43] = u.labelled ?? 0
  }

  // --- label path -----------------------------------------------------
  const mipGeneration = (() => {
    let pipeline: GPURenderPipeline | null = null
    let mipSampler: GPUSampler | null = null
    return (label: GpuLabel): void => {
      if (label.mipLevelCount <= 1) return
      if (!pipeline) {
        const module = moduleFor(MIP_SHADER)
        pipeline = device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs" },
          fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
          primitive: { topology: "triangle-list" },
        })
        mipSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" })
      }
      const encoder = device.createCommandEncoder()
      for (let level = 1; level < label.mipLevelCount; level++) {
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: label.texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
            { binding: 1, resource: mipSampler! },
          ],
        })
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: label.texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
            loadOp: "clear", storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          }],
        })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bindGroup)
        pass.draw(3)
        pass.end()
      }
      device.queue.submit([encoder.finish()])
    }
  })()

  const copyLabel = (label: GpuLabel): boolean => {
    const copy = (device.queue as unknown as {
      copyElementImageToTexture?: CopyElementImageToTexture
    }).copyElementImageToTexture
    if (typeof copy !== "function") return false
    try {
      copy.call(
        device.queue,
        { source: label.dom.element },
        {
          destination: { texture: label.texture },
          width: label.texture.width,
          height: label.texture.height,
        },
      )
      mipGeneration(label)
      // A fresh view AFTER the copy: some Dawn builds do not surface copied
      // content through a view created before the copy.
      label.view = label.texture.createView()
      return true
    } catch {
      return false
    }
  }

  const restartUploads = (): void => {
    cancelUploads?.()
    cancelUploads = driveLabelUploads(
      [...labels], (label) => copyLabel(label as GpuLabel),
    )
  }

  const engine: DrawEngine = {
    backend: "webgpu",

    createMesh(data, layout, indices) {
      const vertexBuffer = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      write(vertexBuffer, 0, data)
      let indexBuffer: GPUBuffer | null = null
      if (indices) {
        indexBuffer = device.createBuffer({
          size: indices.byteLength,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        })
        write(indexBuffer, 0, indices)
      }
      const floats = FLOATS_PER_VERTEX[layout]
      const resource: GpuMesh = {
        vertexBuffer, indexBuffer,
        capacityVertices: data.length / floats, layout,
      }
      meshes.add(resource)
      return {
        layout,
        vertexCount: indices ? indices.length : data.length / floats,
        indexCount: indices ? indices.length : null,
        dynamic: false, resource,
      }
    },

    createDynamicMesh(layout, capacityVertices) {
      const size = capacityVertices * FLOATS_PER_VERTEX[layout] * 4
      const vertexBuffer = device.createBuffer({
        size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      const resource: GpuMesh = {
        vertexBuffer, indexBuffer: null, capacityVertices, layout,
      }
      meshes.add(resource)
      return { layout, vertexCount: 0, indexCount: null, dynamic: true, resource }
    },

    updateMesh(mesh, data, vertexCount) {
      if (!mesh.dynamic) throw new Error("updateMesh on a static mesh")
      const gpuMesh = mesh.resource as GpuMesh
      if (vertexCount > gpuMesh.capacityVertices) {
        throw new Error("updateMesh exceeds capacity")
      }
      write(gpuMesh.vertexBuffer, 0, data)
      ;(mesh as { vertexCount: number }).vertexCount = vertexCount
    },

    destroyMesh(mesh) {
      const gpuMesh = mesh.resource as GpuMesh
      gpuMesh.vertexBuffer.destroy()
      gpuMesh.indexBuffer?.destroy()
      meshes.delete(gpuMesh)
    },

    writeLabel(text, style: LabelStyleToken) {
      const dom = createLabelElement(canvas, text, style)
      const size = dom.textureSize
      const mipLevelCount = mipLevelsFor(size)
      const texture = device.createTexture({
        size: [size, size], format: "rgba8unorm", mipLevelCount,
        usage:
          GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      const label: GpuLabel = {
        texture, view: texture.createView(), mipLevelCount, dom,
      }
      labels.add(label)
      restartUploads()
      return { aspect: 1, resource: label }
    },

    destroyLabel(label: LabelHandle) {
      const gpuLabel = label.resource as GpuLabel
      gpuLabel.texture.destroy()
      gpuLabel.dom.element.remove()
      labels.delete(gpuLabel)
    },

    frame(pass: FramePass, draws: readonly DrawCall[]) {
      if (!msaaTexture || !depthTexture) rebuildTargets()
      ensureUniformCapacity(draws.length)

      // Pack every draw's uniforms into the ring in one write.
      const packed = new Float32Array(Math.max(1, draws.length) * PART_FLOATS)
      draws.forEach((draw, index) => packDraw(packed, index * PART_FLOATS, draw.uniforms))
      write(uniformBuffer, 0, packed)

      const encoder = device.createCommandEncoder()
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: msaaTexture!.createView(),
          resolveTarget: context.getCurrentTexture().createView(),
          clearValue: {
            r: pass.clear[0], g: pass.clear[1], b: pass.clear[2], a: pass.clear[3],
          },
          loadOp: "clear", storeOp: "store",
        }],
        depthStencilAttachment: {
          view: depthTexture!.createView(),
          depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "store",
        },
      })

      draws.forEach((draw, index) => {
        renderPass.setPipeline(pipelineFor(draw.pipeline))
        renderPass.setBindGroup(0, drawBindGroup, [index * PART_STRIDE])
        if (PIPELINES[draw.pipeline].textured) {
          const gpuLabel = (draw.label?.resource ?? null) as GpuLabel | null
          renderPass.setBindGroup(
            1, gpuLabel ? textureBindGroupFor(gpuLabel.view) : blankBindGroup,
          )
        }
        const gpuMesh = draw.mesh.resource as GpuMesh
        renderPass.setVertexBuffer(0, gpuMesh.vertexBuffer)
        if (draw.mesh.indexCount != null && gpuMesh.indexBuffer) {
          renderPass.setIndexBuffer(gpuMesh.indexBuffer, "uint32")
          renderPass.drawIndexed(draw.mesh.indexCount)
        } else {
          renderPass.draw(draw.mesh.vertexCount)
        }
      })
      renderPass.end()
      device.queue.submit([encoder.finish()])
    },

    resize(width, height, dpr) {
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      rebuildTargets()
    },

    dispose() {
      cancelUploads?.()
      for (const mesh of meshes) { mesh.vertexBuffer.destroy(); mesh.indexBuffer?.destroy() }
      meshes.clear()
      for (const label of labels) { label.texture.destroy(); label.dom.element.remove() }
      labels.clear()
      uniformBuffer.destroy()
      blankTexture.destroy()
      msaaTexture?.destroy()
      depthTexture?.destroy()
    },
  }

  return engine
}
