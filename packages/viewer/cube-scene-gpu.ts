// =====================================================================
// packages/viewer/cube-scene-gpu.ts — DRAWING THE VIEW CUBE, IN WEBGPU.
//
// The WebGPU port of the view-cube renderer. Same geometry (buildCube),
// same camera (orthographic, mirrors the model's orientation), same CPU
// ray-cast picking (pickCube) — only the drawing is WebGPU/WGSL instead of
// WebGL2/GLSL. No WebGL fallback: this needs a GPUDevice, and the app gate
// blocks anything that cannot provide one.
//
// MSAA is native here: the pipeline is multisampled (SAMPLE_COUNT) and each
// frame renders into a multisampled colour target that resolves into the
// canvas — clean edges with no off-screen-FBO plumbing.
//
// LABELS: the styled text is rasterised to a 2D canvas and uploaded with
// copyExternalImageToTexture (WebGPU has no texElementImage2D). See
// cube-face-texture-gpu.ts.
// =====================================================================

import {
  buildCube, pickCube,
  PANEL_HALF, PANEL_CORNER_RADIUS, CORNER_DISTANCE,
  type CubeRegion,
} from "./cube"
import {
  createCubeFaceTextureGpu, copyCubeFaceTextureGpu, disposeCubeFaceTextureGpu,
  type CubeFaceTextureGpu,
} from "./cube-face-texture-gpu"
import {
  identity, matrixMultiply, orthographic, lookAt, invert, type Matrix,
} from "./math"
import type { Vector3 } from "@linen/cad/kernel"

/** Half-extent of the orthographic box the cube is drawn into. */
const VIEW_EXTENT = CORNER_DISTANCE + 0.35

/** Label texture span in cube units — the panel's full extent. */
const LABEL_HALF_SPAN = PANEL_HALF + PANEL_CORNER_RADIUS

/** MSAA sample count. 4 is the value WebGPU guarantees for a canvas target;
 *  it is the highest broadly-supported multisample level. */
const SAMPLE_COUNT = 4

// Flat part colours (cube-spec.md §5), matching the WebGL cube.
const FACE_COLOR: readonly [number, number, number] = [0.185, 0.240, 0.370]
const BACK_COLOR: readonly [number, number, number] = [0.145, 0.180, 0.265]
/** The page background (--surface: #16181d). A corner disc is single-sided
 *  and back-face culled, so only its OUTWARD (front) face is ever drawn;
 *  painting it the page colour makes each disc read as a hole to the page
 *  behind the cube. Nothing back-facing is drawn, so the back is unchanged. */
const CORNER_FRONT_COLOR: readonly [number, number, number] = [0x16 / 255, 0x18 / 255, 0x1d / 255]

/** Public interface — identical to the WebGL CubeScene so the widget does
 *  not care which backend drew the cube. */
export interface CubeSceneGpu {
  render(azimuth: number, elevation: number, roll: number): void
  pick(x: number, y: number): CubeRegion | null
  hovered: CubeRegion | null
  resize(size: number, devicePixelRatio: number): void
  dispose(): void
}

/**
 * GL clip space has z ∈ [-1, 1]; WebGPU has z ∈ [0, 1]. math.ts builds
 * GL-style projections, so every view-projection is remapped by this
 * matrix (z' = z*0.5 + 0.5·w) before it reaches the shader. Column-major,
 * matching math.ts.
 */
const GL_TO_WEBGPU_DEPTH: Matrix = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0.5, 0,
  0, 0, 0.5, 1,
]) as unknown as Matrix

const SHADER = /* wgsl */ `
struct Camera { viewProjection : mat4x4<f32> };
@group(0) @binding(0) var<uniform> camera : Camera;

// Per-part data, supplied through a dynamic-offset uniform buffer.
struct Part {
  tint        : vec3<f32>,
  highlighted : f32,
  labelled    : f32,
};
@group(1) @binding(0) var<uniform> part : Part;
@group(1) @binding(1) var labelSampler : sampler;
@group(1) @binding(2) var labelTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@location(0) position : vec3<f32>, @location(1) uv : vec2<f32>) -> VSOut {
  var out : VSOut;
  out.position = camera.viewProjection * vec4<f32>(position, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  // Flat: one constant colour per part, brightened while hovered.
  var shade = mix(part.tint, vec3<f32>(0.42, 0.62, 0.95), part.highlighted * 0.65);

  // textureSample MUST be called in uniform control flow (WGSL computes
  // derivatives across the quad), so it is sampled UNCONDITIONALLY here and
  // masked afterwards — not inside an if, which GLSL allowed but WGSL does
  // not.
  let coverage = textureSample(labelTexture, labelSampler, in.uv).a;
  let inBounds =
    f32(in.uv.x >= 0.0 && in.uv.x <= 1.0 && in.uv.y >= 0.0 && in.uv.y <= 1.0);
  let labelMask = part.labelled * inBounds * coverage;
  shade = mix(shade, vec3<f32>(0.82, 0.87, 0.96), labelMask);

  return vec4<f32>(shade, 1.0);
}
`

interface Batch {
  readonly region: CubeRegion
  readonly firstVertex: number
  readonly vertexCount: number
  readonly label: CubeFaceTextureGpu | null
  /** Byte offset into the per-part uniform buffer. */
  readonly partOffset: number
  /** The bind group carrying this part's uniforms + label. */
  bindGroup: GPUBindGroup
}

/** Uniform buffers must align dynamic offsets to 256 bytes. */
const PART_STRIDE = 256

export type CreateCubeSceneGpu = (
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  context: GPUCanvasContext,
  format: GPUTextureFormat,
) => CubeSceneGpu

export const createCubeSceneGpu: CreateCubeSceneGpu = (
  canvas, device, context, format,
) => {
  // Opt the canvas into HTML-in-Canvas so the nested label elements are
  // laid out and copyable by copyElementImageToTexture.
  canvas.setAttribute("layoutsubtree", "")

  // The cube floats over the HUD, so its canvas must be TRANSPARENT where
  // nothing is drawn. The shared backend configures "opaque"; reconfigure
  // this context for premultiplied alpha (the clear is fully transparent).
  context.configure({
    device,
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    alphaMode: "premultiplied",
  })

  const regions = buildCube()

  // --- vertex data: one interleaved buffer (x,y,z, u,v) --------------
  const vertexData: number[] = []
  const batches: Batch[] = []
  let partOffset = 0

  for (const region of regions) {
    const firstVertex = vertexData.length / 5
    const vertexCount = region.positions.length / 3

    const label =
      region.kind === "face"
        ? createCubeFaceTextureGpu(device, canvas, region.label)
        : null

    // Per-face in-plane frame → label UVs; corner/back parts get (0,0).
    let unitRight: Vector3 = [0, 0, 0]
    let up: Vector3 = [0, 0, 0]
    if (region.kind === "face") {
      const normal = region.normal
      const upWorld: Vector3 =
        Math.abs(normal[2]) > 0.5 ? [0, 1, 0] : [0, 0, 1]
      const right: Vector3 = [
        upWorld[1] * normal[2] - upWorld[2] * normal[1],
        upWorld[2] * normal[0] - upWorld[0] * normal[2],
        upWorld[0] * normal[1] - upWorld[1] * normal[0],
      ]
      const length = Math.hypot(right[0], right[1], right[2]) || 1
      unitRight = [right[0] / length, right[1] / length, right[2] / length]
      up = upWorld
    }

    for (let i = 0; i < region.positions.length; i += 3) {
      const x = region.positions[i]!
      const y = region.positions[i + 1]!
      const z = region.positions[i + 2]!
      let u = 0
      let v = 0
      if (region.kind === "face") {
        u = (x * unitRight[0] + y * unitRight[1] + z * unitRight[2]) /
          (2 * LABEL_HALF_SPAN) + 0.5
        v = (x * up[0] + y * up[1] + z * up[2]) /
          (2 * LABEL_HALF_SPAN) + 0.5
        v = 1 - v
      }
      vertexData.push(x, y, z, u, v)
    }

    batches.push({
      region, firstVertex, vertexCount, label,
      partOffset, bindGroup: null as unknown as GPUBindGroup,
    })
    partOffset += PART_STRIDE
  }

  const vertexBuffer = device.createBuffer({
    label: "cube-vertices",
    size: vertexData.length * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(vertexBuffer, 0, new Float32Array(vertexData))

  // --- uniforms -------------------------------------------------------
  const cameraBuffer = device.createBuffer({
    label: "cube-camera",
    size: 64, // one mat4x4<f32>
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // One big per-part uniform buffer, addressed by dynamic offset.
  const partBuffer = device.createBuffer({
    label: "cube-parts",
    size: batches.length * PART_STRIDE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  // Smoothest sampling the API allows: trilinear (linear mag + min +
  // mipmap) plus maximum anisotropy, so labels stay crisp when a panel is
  // seen edge-on and shrinks along one axis. maxAnisotropy 16 is the ceiling
  // every WebGPU implementation supports; it only takes effect with linear
  // min+mipmap filtering, which is why all three are linear.
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    maxAnisotropy: 16,
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  })

  // A 1x1 transparent fallback for parts without a label, so every bind
  // group has a valid texture binding.
  const blankTexture = device.createTexture({
    size: [1, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture(
    { texture: blankTexture }, new Uint8Array([0, 0, 0, 0]),
    { bytesPerRow: 4 }, [1, 1],
  )
  const blankView = blankTexture.createView()

  const module = device.createShaderModule({ label: "cube-shader", code: SHADER })

  const cameraLayout = device.createBindGroupLayout({
    entries: [{
      binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" },
    }],
  })
  const partLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0, visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", hasDynamicOffset: true },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ],
  })

  const pipeline = device.createRenderPipeline({
    label: "cube-pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [cameraLayout, partLayout],
    }),
    vertex: {
      module, entryPoint: "vs",
      buffers: [{
        arrayStride: 5 * 4,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 3 * 4, format: "float32x2" },
        ],
      }],
    },
    fragment: {
      module, entryPoint: "fs",
      targets: [{ format }],
    },
    primitive: {
      topology: "triangle-list",
      // Two-plate magic: front plate faces out, back faces in, wound
      // oppositely — back-face culling keeps one per side (cube-spec.md).
      cullMode: "back",
      frontFace: "ccw",
    },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
    multisample: { count: SAMPLE_COUNT },
  })

  const cameraBindGroup = device.createBindGroup({
    layout: cameraLayout,
    entries: [{ binding: 0, resource: { buffer: cameraBuffer } }],
  })

  const rebuildPartBindGroups = (): void => {
    for (const batch of batches) {
      batch.bindGroup = device.createBindGroup({
        layout: partLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: partBuffer, offset: 0, size: 32 },
          },
          { binding: 1, resource: sampler },
          { binding: 2, resource: batch.label?.view ?? blankView },
        ],
      })
    }
  }
  rebuildPartBindGroups()

  // Write each part's static uniform block once (tint/highlighted/labelled
  // change per frame for hover, so tint+labelled are written now and
  // highlighted is refreshed in render).
  const writePartUniforms = (hovered: CubeRegion | null): void => {
    const data = new Float32Array(batches.length * (PART_STRIDE / 4))
    for (const batch of batches) {
      const base = batch.partOffset / 4
      const color =
        batch.region.kind === "corner" ? CORNER_FRONT_COLOR
          : batch.region.kind === "back" ? BACK_COLOR
            : FACE_COLOR
      // WGSL layout: vec3<f32> has align 16 but SIZE 12, and a following
      // scalar (align 4) packs into the padding at byte 12. So:
      //   tint        -> bytes 0..11  (floats 0,1,2)
      //   highlighted -> byte  12     (float 3)
      //   labelled    -> byte  16     (float 4)
      data[base + 0] = color[0]
      data[base + 1] = color[1]
      data[base + 2] = color[2]
      data[base + 3] = hovered?.id === batch.region.id ? 1 : 0 // highlighted @12
      data[base + 4] = batch.label ? 1 : 0                     // labelled @16
    }
    device.queue.writeBuffer(partBuffer, 0, data)
  }

  // --- MSAA + depth targets, rebuilt on resize -----------------------
  let msaaTexture: GPUTexture | null = null
  let depthTexture: GPUTexture | null = null
  let pixelSize = 1
  let lastViewProjection: Matrix = identity()

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

  // Keep the label textures synced with the live DOM. `onpaint` fires when
  // the nested HTML changes (hover, text, layout) — the HTML-in-Canvas
  // sync signal — so the copies stay current without a per-frame flush. We
  // also attempt one copy right away in case the elements are already
  // painted, and fall back to a rAF retry until each takes (the first
  // paint may not have a record yet).
  const labelFaces = batches
    .map((batch) => batch.label)
    .filter((label): label is CubeFaceTextureGpu => label !== null)

  // Labels each copy EXACTLY ONCE, when their paint record first exists.
  //
  // A failed copyElementImageToTexture emits a WebGPU validation message to
  // the console that a JS try/catch cannot suppress — so calling it every
  // frame (or on every onpaint) before the record lands FLOODS the console.
  // The guard: track which faces still need a copy, drop each the instant
  // it succeeds, and stop touching the API entirely once none remain. The
  // static labels never change after that, so there is nothing to re-sync.
  const copyOne = (face: CubeFaceTextureGpu): boolean => {
    if (!copyCubeFaceTextureGpu(device, face)) return false
    // Rebuild the bind group of every batch using this label AFTER the copy
    // lands, from a FRESH view — some Dawn builds do not surface the copied
    // content through a view created before the copy.
    for (const batch of batches) {
      if (batch.label === face) {
        batch.bindGroup = device.createBindGroup({
          layout: partLayout,
          entries: [
            { binding: 0, resource: { buffer: partBuffer, offset: 0, size: 32 } },
            { binding: 1, resource: sampler },
            { binding: 2, resource: face.texture.createView() },
          ],
        })
      }
    }
    return true
  }

  // Copy on EVERY onpaint, not just the first. The initial paint record can
  // exist before the element is fully painted, so an early copy lands empty
  // pixels; later paints carry the real content. onpaint fires only on
  // actual repaints (a finite, small number as layout settles), so re-doing
  // the copy each time is cheap and never a busy-loop. We stop wiring new
  // copies only after a quiet period, not after the first success.
  const canvasWithPaint = canvas as HTMLCanvasElement & { onpaint?: (() => void) | null }
  canvasWithPaint.onpaint = () => {
    for (const face of labelFaces) copyOne(face)
  }

  const state = { hovered: null as CubeRegion | null }

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
    const worldUp: Vector3 = [
      -Math.sin(elevation) * Math.cos(azimuth),
      -Math.sin(elevation) * Math.sin(azimuth),
      Math.cos(elevation),
    ]
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
      if (!msaaTexture || !depthTexture) rebuildTargets()

      const viewProjection = viewProjectionFor(azimuth, elevation, roll)
      lastViewProjection = viewProjection
      // Remap GL depth [-1,1] to WebGPU [0,1] before the shader.
      const corrected = matrixMultiply(GL_TO_WEBGPU_DEPTH, viewProjection)
      device.queue.writeBuffer(
        cameraBuffer, 0, new Float32Array(corrected as unknown as Float32Array),
      )
      writePartUniforms(state.hovered)

      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: msaaTexture!.createView(),
          resolveTarget: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: depthTexture!.createView(),
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      })

      pass.setPipeline(pipeline)
      pass.setBindGroup(0, cameraBindGroup)
      pass.setVertexBuffer(0, vertexBuffer)
      for (const batch of batches) {
        pass.setBindGroup(1, batch.bindGroup, [batch.partOffset])
        pass.draw(batch.vertexCount, 1, batch.firstVertex, 0)
      }
      pass.end()
      device.queue.submit([encoder.finish()])
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
      canvas.width = Math.max(1, Math.round(size * devicePixelRatio))
      canvas.height = Math.max(1, Math.round(size * devicePixelRatio))
      rebuildTargets()
    },

    dispose() {
      for (const batch of batches) {
        if (batch.label) disposeCubeFaceTextureGpu(batch.label)
      }
      vertexBuffer.destroy()
      cameraBuffer.destroy()
      partBuffer.destroy()
      blankTexture.destroy()
      msaaTexture?.destroy()
      depthTexture?.destroy()
    },
  }
}
