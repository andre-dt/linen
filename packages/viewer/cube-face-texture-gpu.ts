// =====================================================================
// packages/viewer/cube-face-texture-gpu.ts — FACE LABELS FOR THE WEBGPU
// VIEW CUBE, via the real HTML-in-Canvas path.
//
// The label is a live, styled HTML element nested under the canvas
// (opted in with `layoutsubtree`) and copied into a WebGPU texture with
// `GPUDevice.queue.copyElementImageToTexture` — the WebGPU analog of the
// WebGL `texElementImage2D`. The element stays in the DOM, so screen
// readers, text selection and CSS all keep working; the fragment shader
// just samples its rendered pixels.
//
// Sync is driven by `canvas.onpaint` (wired in cube-scene-gpu.ts), which
// fires whenever the nested HTML changes, so the textures stay current
// without a manual per-frame flush.
// =====================================================================

/** A face label backed by a live DOM element and a WebGPU texture. */
export interface CubeFaceTextureGpu {
  readonly texture: GPUTexture
  readonly view: GPUTextureView
  /** How many mip levels the texture carries — computed from its size so
   *  mip generation and the sampler agree. */
  readonly mipLevelCount: number
  /** The live DOM child, retained to re-copy on paint and to remove on
   *  dispose. */
  readonly element: HTMLElement
  readonly aspect: number
}

/** Full mip chain down to 1×1 for a square texture of the given side. */
const mipLevelsFor = (size: number): number =>
  Math.floor(Math.log2(size)) + 1

/** The queue method the HTML-in-Canvas API adds. Declared locally because
 *  the ambient lib types do not ship it yet (it rides a flag).
 *
 *  It is a TWO-argument call, matching the WICG IDL:
 *    copyElementImageToTexture(GPUCopyElementImageSource source,
 *                              GPUCopyElementImageDestination destination)
 *  where `source` wraps the element in a `source` member and `destination`
 *  wraps the target texture in a `destination` member AND carries the copy
 *  size as its own `width`/`height` members — there is NO third copySize
 *  argument (an earlier version passed one, and the copy silently no-opped). */
type CopyElementImageToTexture = (
  source: { source: Element },
  destination: {
    destination: GPUImageCopyTexture
    width: number
    height: number
  },
) => void

/** Side of the square texture each label is drawn into. 512, not 256: the
 *  panel is ~160px at devicePixelRatio 2 (~320 device px), so a 256 texture
 *  is magnified and the glyphs soften. 512 keeps the label oversampled on
 *  every display, so trilinear sampling only ever minifies — sharp, never
 *  blurred by upscaling. */
const FACE_TEXTURE_SIZE = 512

/**
 * Create a label element under the canvas and its destination texture.
 *
 * The element MUST be a direct child of a `<canvas layoutsubtree>` for the
 * API to lay it out and read it. It is positioned at the canvas origin but
 * painted over by the canvas, so it is not separately visible. The actual
 * pixel copy happens in `copyCubeFaceTextureGpu`, called from the canvas
 * paint handler once layout has settled.
 */
export type CreateCubeFaceTextureGpu = (
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  label: string,
) => CubeFaceTextureGpu | null

export const createCubeFaceTextureGpu: CreateCubeFaceTextureGpu = (
  device, canvas, label,
) => {
  const element = document.createElement("div")
  element.className = "cube-face-label"
  element.textContent = label
  element.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    `width:${FACE_TEXTURE_SIZE}px`,
    `height:${FACE_TEXTURE_SIZE}px`,
    "pointer-events:none",
  ].join(";")
  canvas.appendChild(element)

  const mipLevelCount = mipLevelsFor(FACE_TEXTURE_SIZE)
  const texture = device.createTexture({
    label: `cube-face:${label}`,
    size: [FACE_TEXTURE_SIZE, FACE_TEXTURE_SIZE],
    format: "rgba8unorm",
    mipLevelCount,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.RENDER_ATTACHMENT,
  })

  return { texture, view: texture.createView(), mipLevelCount, element, aspect: 1 }
}

// --- mip generation -------------------------------------------------------
// copyElementImageToTexture writes ONLY mip level 0. The sampler is trilinear
// with anisotropy, so the smaller levels must be filled or minified labels
// sample an undefined (usually transparent) chain and vanish. A tiny blit
// pipeline downsamples each level from the one above, linearly — the standard
// WebGPU mipmap trick, cached per device so it is built once.

interface MipGenerator {
  readonly pipeline: GPURenderPipeline
  readonly sampler: GPUSampler
}
const mipGenerators = new WeakMap<GPUDevice, MipGenerator>()

const MIP_SHADER = /* wgsl */ `
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var samp : sampler;
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i : u32) -> VSOut {
  // Full-screen triangle.
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

const mipGeneratorFor = (device: GPUDevice): MipGenerator => {
  const cached = mipGenerators.get(device)
  if (cached) return cached
  const module = device.createShaderModule({ label: "mip-shader", code: MIP_SHADER })
  const pipeline = device.createRenderPipeline({
    label: "mip-pipeline",
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list" },
  })
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" })
  const generator: MipGenerator = { pipeline, sampler }
  mipGenerators.set(device, generator)
  return generator
}

/** Fill every mip level below 0 by successively downsampling. */
const generateMips = (device: GPUDevice, face: CubeFaceTextureGpu): void => {
  if (face.mipLevelCount <= 1) return
  const { pipeline, sampler } = mipGeneratorFor(device)
  const encoder = device.createCommandEncoder({ label: "mip-encoder" })
  for (let level = 1; level < face.mipLevelCount; level++) {
    const srcView = face.texture.createView({
      baseMipLevel: level - 1, mipLevelCount: 1,
    })
    const dstView = face.texture.createView({
      baseMipLevel: level, mipLevelCount: 1,
    })
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: sampler },
      ],
    })
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: dstView, loadOp: "clear", storeOp: "store",
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

/**
 * Copy the (laid-out, painted) element into its texture. Called from the
 * canvas paint handler. Safe to retry — before the element has a paint
 * record the copy throws, which is swallowed so the cube keeps its blank
 * placeholder rather than the whole scene dying.
 */
export type CopyCubeFaceTextureGpu = (
  device: GPUDevice,
  face: CubeFaceTextureGpu,
) => boolean

export const copyCubeFaceTextureGpu: CopyCubeFaceTextureGpu = (device, face) => {
  const copy = (device.queue as unknown as {
    copyElementImageToTexture?: CopyElementImageToTexture
  }).copyElementImageToTexture
  if (typeof copy !== "function") return false
  try {
    copy.call(
      device.queue,
      { source: face.element },
      {
        destination: { texture: face.texture },
        width: face.texture.width,
        height: face.texture.height,
      },
    )
    // The copy only touched mip 0; refill the chain so trilinear sampling
    // has smooth minified levels.
    generateMips(device, face)
    return true
  } catch {
    // Not painted yet, or the API rejected — leave the placeholder.
    return false
  }
}

/** Free a face texture and its DOM child. */
export type DisposeCubeFaceTextureGpu = (face: CubeFaceTextureGpu) => void
export const disposeCubeFaceTextureGpu: DisposeCubeFaceTextureGpu = (face) => {
  face.texture.destroy()
  face.element.remove()
}
