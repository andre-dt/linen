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
  /** The live DOM child, retained to re-copy on paint and to remove on
   *  dispose. */
  readonly element: HTMLElement
  readonly aspect: number
}

/** The queue method the HTML-in-Canvas API adds. Declared locally because
 *  the ambient lib types do not ship it yet (it rides a flag). The source
 *  is a `GPUCopyElementImageSource` — an object with a `source` member —
 *  not the bare element. */
type CopyElementImageToTexture = (
  source: { source: Element },
  destination: { destination: GPUImageCopyTexture },
  copySize: GPUExtent3DStrict,
) => void

/** Side of the square texture each label is drawn into. */
const FACE_TEXTURE_SIZE = 256

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

  const texture = device.createTexture({
    label: `cube-face:${label}`,
    size: [FACE_TEXTURE_SIZE, FACE_TEXTURE_SIZE],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.RENDER_ATTACHMENT,
  })

  return { texture, view: texture.createView(), element, aspect: 1 }
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
      { destination: { texture: face.texture } },
      [face.texture.width, face.texture.height],
    )
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
