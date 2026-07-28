// =====================================================================
// packages/viewer/cube-face-texture.ts — HTML FACE LABELS, VIA
// HTML-IN-CANVAS.
//
// Each view-cube FACE used to get its label from a canvas2D bitmap baked
// by text.ts. Now the label is a real, styled HTML element uploaded to a
// WebGL texture with `texElementImage2D` — the HTML-in-Canvas path. The
// visual is no longer "white text on transparent" but whatever CSS says:
// a proper panel, its type, and (later) icons or hover states, drawn by
// the browser's own text engine at device resolution.
//
// Only the SOURCE of the texture changes. The cube's geometry, its
// derived UVs, the two-pass draw and the picking all stay exactly as they
// were — this returns the same `{ texture, aspect }` shape text.ts did, so
// nothing downstream has to know where the pixels came from.
//
// REQUIREMENTS of the API (see capability.ts for the gate that guarantees
// them before any of this runs):
//   - the CANVAS must carry the `layoutsubtree` attribute, and
//   - the element must be a DIRECT CHILD of that canvas, with a generated
//     box (not display:none), or `texElementImage2D` has nothing to lay
//     out and read.
// =====================================================================

/** The face texture plus the aspect its UVs need — deliberately the same
 *  shape text.ts returned, so cube-scene.ts consumes it unchanged. */
export interface CubeFaceTexture {
  readonly texture: WebGLTexture
  /** width / height of the drawn element, for non-square label spans. */
  readonly aspect: number
  /** The live DOM child, retained so it can be removed on dispose. */
  readonly element: HTMLElement
}

/** The subset of the HTML-in-Canvas WebGL method we call. Declared here
 *  because the ambient lib types do not ship it yet (it rides a flag). */
type TexElementImage2D = (
  target: number,
  internalformat: number,
  element: Element,
) => void

/** Side of the square bitmap each face is drawn into. Faces are read at a
 *  distance and never fill more than a fraction of the panel, so a modest
 *  power-of-two is plenty and keeps the per-face layout cheap. */
const FACE_TEXTURE_SIZE = 256

/**
 * Build one face's label element, parent it under the cube canvas, and
 * upload it as a texture.
 *
 * The element is positioned OFF-SCREEN but laid out: it must have a real
 * box for `texElementImage2D` to capture, but it must never be visible in
 * the page — only its drawn copy on the cube is. The canvas is its offset
 * parent (it is a child of the canvas), so absolute placement is relative
 * to the canvas box.
 */
export type CreateCubeFaceTexture = (
  gl: WebGL2RenderingContext,
  canvas: HTMLCanvasElement,
  label: string,
) => CubeFaceTexture | null

export const createCubeFaceTexture: CreateCubeFaceTexture = (gl, canvas, label) => {
  const draw = (gl as unknown as { texElementImage2D?: TexElementImage2D })
    .texElementImage2D
  // The gate should have caught this already; guarding keeps the helper
  // honest if it is ever called on an unsupported context directly.
  if (typeof draw !== "function") return null

  const element = document.createElement("div")
  element.className = "cube-face-label"
  element.textContent = label
  // A real, PAINTED box — not hidden off-screen. `texElementImage2D` reads
  // the element's cached PAINT record, and an element pulled to
  // `left:-9999px` under `contain:strict` never gets one ("No cached paint
  // record for element"). It sits at the canvas origin instead; the canvas
  // itself paints over it, so it is not separately visible in the page.
  element.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    `width:${FACE_TEXTURE_SIZE}px`,
    `height:${FACE_TEXTURE_SIZE}px`,
    "pointer-events:none",
  ].join(";")
  // MUST be a child of the canvas for the API to lay it out and read it.
  canvas.appendChild(element)

  const texture = gl.createTexture()
  if (!texture) {
    element.remove()
    return null
  }
  // Start as a 1x1 transparent pixel so the cube can draw THIS FRAME,
  // before the element has a paint record. The real element is uploaded by
  // uploadCubeFaceTexture once a frame has painted — see cube-scene.ts,
  // which schedules that on the next animation frame.
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0]),
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)

  // The box is square, so aspect is 1; kept explicit because cube-scene.ts
  // reads `.aspect` to size the label span and a missing field would make
  // it fall back to a value that stretches the text.
  return { texture, aspect: 1, element }
}

/**
 * Upload the (now painted) element into its texture.
 *
 * Split from create because `texElementImage2D` needs the element to have
 * been laid out AND painted at least once; called on the frame after the
 * elements were parented. Safe to retry — a still-unpainted element throws
 * "No cached paint record", which is swallowed so the cube keeps its
 * placeholder rather than the whole scene dying.
 */
export type UploadCubeFaceTexture = (
  gl: WebGL2RenderingContext,
  face: CubeFaceTexture,
) => boolean

export const uploadCubeFaceTexture: UploadCubeFaceTexture = (gl, face) => {
  const draw = (gl as unknown as { texElementImage2D?: TexElementImage2D })
    .texElementImage2D
  if (typeof draw !== "function") return false
  try {
    gl.bindTexture(gl.TEXTURE_2D, face.texture)
    // SIZED internalformat (RGBA8): the unsized `RGBA` is rejected with
    // "Invalid internalformat". RGBA8 keeps the CSS alpha intact.
    draw.call(gl, gl.TEXTURE_2D, gl.RGBA8, face.element)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(
      gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR,
    )
    gl.bindTexture(gl.TEXTURE_2D, null)
    return true
  } catch {
    // Not painted yet. Leave the placeholder; the caller may retry.
    gl.bindTexture(gl.TEXTURE_2D, null)
    return false
  }
}

/** Remove a face texture and its DOM child. Pairs with create; the
 *  element must be detached or every rebuild leaks a node under the
 *  canvas. */
export type DisposeCubeFaceTexture = (
  gl: WebGL2RenderingContext,
  face: CubeFaceTexture,
) => void

export const disposeCubeFaceTexture: DisposeCubeFaceTexture = (gl, face) => {
  gl.deleteTexture(face.texture)
  face.element.remove()
}
