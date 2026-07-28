// =====================================================================
// packages/viewer/capability.ts — WHAT THIS BROWSER CAN RENDER.
//
// The viewport now draws its UI chrome — the origin marker, the datum
// plane labels, the view cube — as live HTML composited into the canvas
// with the HTML-in-Canvas `drawElementImage()` API, not as hand-rolled
// WebGL. That API is Chromium-only (147+, behind the `canvas-draw-element`
// flag) and there is NO software fallback: without it the chrome cannot
// be drawn at all.
//
// So the viewport has two hard requirements — a 3D backend AND the
// HTML-in-Canvas API — and when either is missing the ONLY thing that
// fails is the 3D canvas: it shows a message in place of itself and the
// rest of the app keeps working. Each missing capability gets its OWN
// specific message, because "the viewport didn't load" tells a user
// nothing about whether to enable a flag or switch browsers.
// =====================================================================

/** A single missing capability, named so the caller can show the right
 *  message and, if it wants, branch on which one is absent. */
export type CapabilityReason = "no-3d-backend" | "no-html-in-canvas"

export interface CapabilityReport {
  /** True only when every requirement below is met. */
  readonly ok: boolean
  /** Every unmet requirement, in the order they should be reported. */
  readonly missing: readonly CapabilityReason[]
}

/** The user-facing text for each condition. Specific on purpose: it names
 *  the actual missing thing and the actual way to get it, so the message
 *  is actionable rather than a generic "unsupported browser". */
export const CAPABILITY_MESSAGE: Record<CapabilityReason, string> = {
  "no-3d-backend":
    "This browser has no usable 3D graphics. Linen's viewport needs " +
    "WebGL2 or WebGPU, which means hardware acceleration must be enabled " +
    "and not blocked by the browser or the GPU driver.",
  "no-html-in-canvas":
    "This browser does not support the HTML-in-Canvas API, which Linen's " +
    "viewport uses to draw its on-screen controls. It is currently " +
    "available only in Chromium 147 or newer with the " +
    '"canvas-draw-element" flag enabled at chrome://flags.',
}

/**
 * Does a fresh canvas yield a WebGL2 (or WebGPU) rendering context?
 *
 * A cheap, throwaway probe — it creates a detached canvas, asks for the
 * context, and discards it. This is intentionally NOT the real backend
 * setup (that lives in backend.ts and does far more); it only answers the
 * yes/no question the gate needs before a viewport is even mounted.
 */
export type HasThreeDBackend = () => boolean
export const hasThreeDBackend: HasThreeDBackend = () => {
  if (typeof document === "undefined") return false
  const canvas = document.createElement("canvas")
  // WebGL2 is what createScene actually draws with today; WebGPU counts
  // too, since backend.ts prefers it and the gate must not reject a
  // machine that has one. Either is enough to say "3D works here".
  const webgl2 = canvas.getContext("webgl2")
  if (webgl2) return true
  return typeof navigator !== "undefined" && "gpu" in navigator
}

/**
 * Is the HTML-in-Canvas `drawElementImage()` API present?
 *
 * Feature-detected off the 2D context prototype rather than assumed from
 * a user-agent string: the API rides a flag, so the same Chromium build
 * both has and lacks it depending on the user's chrome://flags. The
 * prototype either carries the method or it does not.
 */
export type HasHtmlInCanvas = () => boolean
export const hasHtmlInCanvas: HasHtmlInCanvas = () => {
  if (typeof CanvasRenderingContext2D === "undefined") return false
  return typeof (
    CanvasRenderingContext2D.prototype as unknown as {
      drawElementImage?: unknown
    }
  ).drawElementImage === "function"
}

/**
 * The full capability check the viewport gate runs once, up front.
 *
 * Reports EVERY missing requirement, not just the first — a browser can
 * lack both, and telling the user only about the backend when the flag is
 * also off would send them fixing one thing and hitting the wall on the
 * next.
 */
export type CheckViewportCapabilities = () => CapabilityReport
export const checkViewportCapabilities: CheckViewportCapabilities = () => {
  const missing: CapabilityReason[] = []
  if (!hasThreeDBackend()) missing.push("no-3d-backend")
  if (!hasHtmlInCanvas()) missing.push("no-html-in-canvas")
  return { ok: missing.length === 0, missing }
}
