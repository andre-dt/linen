// =====================================================================
// packages/viewer/engine/label-style.ts — THE CANONICAL LABEL STYLES.
//
// The engine draws text as HTML, but the caller never writes CSS. There is
// one fixed set of label looks, named by TOKEN; a call site picks a token
// and the engine stamps the matching style onto the element. This is what
// keeps every label in the viewer visually consistent, and what lets a
// datum-plane name reuse the exact type treatment proven on the view cube.
//
// WHY TOKENS, NOT A STYLE OBJECT
// ------------------------------
// A `writeLabel(text, { fontSize, weight, colour, … })` API would push a
// per-call-site style decision back out to the callers — precisely the
// scatter this refactor removes. A closed set of tokens keeps the look in
// ONE place, reviewable and coherent, and makes "the labels changed" a
// one-line diff here rather than a hunt across the scene.
//
// The values mirror the styling that lived in `.cube-face-label` in
// styles.css and the old canvas2D `text.ts`, so nothing regresses visually
// as those paths retire.
// =====================================================================

/** The available label looks. Extend this set (and STYLES below) to add a
 *  new treatment; call sites can only ever ask for a token that exists. */
export type LabelStyleToken = "cube-face" | "plane"

/** A resolved label style — the concrete knobs the engine turns into CSS.
 *  Kept backend-neutral: both the WebGL and WebGPU label paths read this. */
export interface LabelStyle {
  /** Side of the square texture the element is drawn into, in CSS pixels.
   *  Larger than the on-screen size so sampling only ever minifies —
   *  trilinear downscaling stays crisp where upscaling would soften. */
  readonly textureSize: number
  readonly fontFamily: string
  /** Font size in CSS pixels, relative to `textureSize`. */
  readonly fontSize: number
  readonly fontWeight: number
  readonly letterSpacing: number
  /** Text colour, any CSS colour string. Labels sampled by a tinting
   *  shader (planes) use white and let the shader colour them; labels
   *  composited as-is (the cube) carry their final colour here. */
  readonly color: string
  /** Horizontal padding in CSS pixels, so glyphs stay off the edge where
   *  clamped sampling would fray them. */
  readonly paddingX: number
}

/**
 * The one-and-only style table. `var(--…)` values resolve against the
 * page, so a theme change carries through to the labels for free.
 */
const STYLES: Record<LabelStyleToken, LabelStyle> = {
  // The view-cube plate label. Values transcribed from the old
  // `.cube-face-label` rule: a large, semi-bold, tracked word centred in a
  // 512px box, in the HUD text colour.
  "cube-face": {
    textureSize: 512,
    fontFamily: "var(--font-ui, system-ui, sans-serif)",
    fontSize: 80,
    fontWeight: 600,
    letterSpacing: 2,
    color: "var(--hud-text, #e6e9ef)",
    paddingX: 24,
  },
  // The datum-plane name, stamped INTO the plane. White because the plane
  // shader tints it per hover/select state (so one texture serves every
  // state); the geometry is what carries its position and skew. Same family
  // and weight as the cube so the two read as one type system.
  "plane": {
    textureSize: 512,
    fontFamily: "var(--font-ui, system-ui, sans-serif)",
    fontSize: 150,
    fontWeight: 600,
    letterSpacing: 2,
    color: "#ffffff",
    paddingX: 24,
  },
}

/** Resolve a token to its concrete style. */
export type ResolveLabelStyle = (token: LabelStyleToken) => LabelStyle
export const resolveLabelStyle: ResolveLabelStyle = (token) => STYLES[token]

/**
 * The inline CSS text for a label element of a given style. Centres the
 * word in the square texture box and maxes out font smoothing, matching the
 * old rule. Positioned at the canvas origin (painted over by the canvas, so
 * never separately visible) because the HTML-in-Canvas APIs read an
 * element's cached PAINT record — it must have a real, on-screen box.
 */
export type LabelElementCss = (style: LabelStyle) => string
export const labelElementCss: LabelElementCss = (style) =>
  [
    "position:absolute",
    "left:0",
    "top:0",
    `width:${style.textureSize}px`,
    `height:${style.textureSize}px`,
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "box-sizing:border-box",
    "background:transparent",
    "pointer-events:none",
    `padding:0 ${style.paddingX}px`,
    "text-align:center",
    "white-space:nowrap",
    `font-family:${style.fontFamily}`,
    `font-size:${style.fontSize}px`,
    `font-weight:${style.fontWeight}`,
    `letter-spacing:${style.letterSpacing}px`,
    `color:${style.color}`,
    "-webkit-font-smoothing:antialiased",
    "-moz-osx-font-smoothing:grayscale",
  ].join(";")
