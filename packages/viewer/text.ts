// =====================================================================
// packages/viewer/text.ts — TEXT AS A TEXTURE.
//
// Renders a short string to a texture, so it can be stamped onto
// geometry and share that geometry's perspective.
//
// WHY NOT DOM
// -----------
// A positioned <span> is crisp and cheap, and it was the first thing
// tried here. But it is a SPRITE: it always faces the viewer, flat, at a
// fixed size. A plane's name belongs to the plane — it should skew as
// the surface turns away, and shrink as the surface recedes, the way a
// label printed on a drawing does. Only geometry can do that, and
// geometry needs a texture.
//
// WHY NOT A FONT ATLAS
// --------------------
// The usual answer for text in a 3D scene is a signed-distance-field
// atlas: one texture, every glyph, laid out at draw time. That is the
// right tool for dynamic text — dimensions, measurements, anything the
// user types. These labels are six fixed words, baked once at startup
// and never changed. A per-string texture is a few lines and looks
// perfect at the size it is drawn; an atlas would be several hundred
// lines to reach the same place.
//
// Revisit this when dimension annotations land — those ARE dynamic, and
// that is when an atlas starts paying for itself.
// =====================================================================

export interface TextTexture {
  readonly texture: WebGLTexture
  /** Pixel size of the rendered bitmap, for choosing a quad aspect. */
  readonly width: number
  readonly height: number
  /** Width divided by height — what the caller sizes the quad by, so the
   *  text is never stretched. */
  readonly aspect: number
}

/**
 * Renders `text` white-on-transparent and uploads it.
 *
 * White because the shader tints it: one texture can then serve the idle
 * and highlighted states by multiplying, instead of being re-rendered
 * whenever the colour changes.
 *
 * `scale` oversamples relative to the on-screen size, and the browser's
 * own font rasteriser does the anti-aliasing — which is the same
 * hinted, gamma-corrected output the rest of the interface uses.
 *
 * A signed distance field was tried here for "vector-crisp" edges. It
 * looked worse: the field fills every texel, so the transparent margin
 * around the glyphs stopped being transparent and the label gained a
 * pale rectangle. Sharpness at an angle turned out to be a FILTERING
 * problem, not a representation one — see the anisotropy below.
 */export const createTextTexture = (
  gl: WebGL2RenderingContext,
  text: string,
  options: {
    readonly fontSize?: number
    readonly fontFamily?: string
    readonly letterSpacing?: number
    readonly scale?: number
    /** CSS font weight. Defaults to 500. */
    readonly weight?: number
  } = {},
): TextTexture | null => {
  const fontSize = options.fontSize ?? 32
  const fontFamily = options.fontFamily ?? "system-ui, sans-serif"
  // Rasterise large, then measure distances on that. The field itself is
  // resolution-independent, so this only needs to be fine enough to
  // capture the glyph outlines accurately.
  const scale = options.scale ?? 4
  // 600 was the original and reads heavy on the view cube, where the
  // labels sit on small facets and every stroke competes with the
  // bevels. Callers that want the old weight ask for it.
  const weight = options.weight ?? 500

  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d")
  // No 2D context — a headless or context-lost environment. The caller
  // draws no label rather than failing the whole scene over a caption.
  if (!context) return null

  const font = `${weight} ${fontSize * scale}px ${fontFamily}`
  context.font = font
  if (options.letterSpacing) {
    // Not supported everywhere; harmless where it is ignored.
    ;(context as { letterSpacing?: string }).letterSpacing =
      `${options.letterSpacing * scale}px`
    context.font = font
  }

  const metrics = context.measureText(text)
  // Padding keeps the glyphs off the very edge, where bilinear sampling
  // would blend them with the transparent border and fray the strokes.
  const padding = Math.ceil(fontSize * scale * 0.25)
  canvas.width = Math.max(1, Math.ceil(metrics.width) + padding * 2)
  canvas.height = Math.max(1, Math.ceil(fontSize * scale * 1.4) + padding * 2)

  // Resizing the canvas resets the context, so the font must be set again.
  context.font = font
  if (options.letterSpacing) {
    ;(context as { letterSpacing?: string }).letterSpacing =
      `${options.letterSpacing * scale}px`
    context.font = font
  }
  context.textBaseline = "middle"
  context.textAlign = "left"
  context.fillStyle = "#ffffff"
  context.fillText(text, padding, canvas.height / 2)

  const texture = gl.createTexture()
  if (!texture) return null
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)

  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  // Anisotropic filtering, where the driver offers it. These labels lie
  // ON a surface the camera almost never faces squarely, and at a
  // grazing angle plain trilinear picks a mip based on the WORST axis —
  // blurring the direction that was still sharp. This is most of the
  // remaining softness.
  const anisotropic =
    gl.getExtension("EXT_texture_filter_anisotropic") ??
    gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic")
  if (anisotropic) {
    const maximum = gl.getParameter(
      anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT,
    ) as number
    gl.texParameterf(
      gl.TEXTURE_2D, anisotropic.TEXTURE_MAX_ANISOTROPY_EXT,
      Math.min(16, maximum),
    )
  }
  // Clamp: the quad samples exactly [0,1], and repeating would wrap a
  // stray column of glyph onto the opposite edge.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)

  return {
    texture,
    width: canvas.width,
    height: canvas.height,
    aspect: canvas.width / canvas.height,
  }
}
