// =====================================================================
// packages/viewer/engine/label-texture.ts — THE HTML-IN-CANVAS PLUMBING.
//
// Shared, backend-neutral machinery for "a live HTML element becomes a GPU
// texture". Both WebGL (`texElementImage2D`) and WebGPU
// (`copyElementImageToTexture`) work the same way at this level:
//
//   1. create a styled <div> child of the canvas (which must carry
//      `layoutsubtree`), positioned at the origin so it has a real paint
//      box but is painted over by the canvas itself;
//   2. wait for the browser to LAY OUT and PAINT it — the copy APIs read a
//      cached paint record and throw ("No cached paint record") before one
//      exists;
//   3. copy its pixels into a texture, and keep retrying on paint until the
//      copy takes, because the first paint record can predate real content.
//
// Only step 3's actual copy differs between backends, so it is injected as
// a hook. Everything else — the element, the CSS, the retry loop, disposal
// — lives here once, which is the whole point of the engine.
// =====================================================================

import {
  labelElementCss, resolveLabelStyle, type LabelStyleToken,
} from "./label-style"

/** The live DOM element for a label, plus the style it was built with. */
export interface LabelElement {
  readonly element: HTMLElement
  /** Side of the square texture, from the style — both backends size the
   *  destination texture and its mip chain by this. */
  readonly textureSize: number
}

/**
 * Build a label's DOM element and parent it under the canvas. The element
 * MUST be a direct child of a `<canvas layoutsubtree>` for the HTML-in-Canvas
 * APIs to lay it out and read it; the caller (the engine) guarantees the
 * attribute is set.
 */
export type CreateLabelElement = (
  canvas: HTMLCanvasElement,
  text: string,
  token: LabelStyleToken,
) => LabelElement

export const createLabelElement: CreateLabelElement = (canvas, text, token) => {
  const style = resolveLabelStyle(token)
  const element = document.createElement("div")
  element.className = `viewer-label viewer-label-${token}`
  element.textContent = text
  element.style.cssText = labelElementCss(style)
  canvas.appendChild(element)
  return { element, textureSize: style.textureSize }
}

/** Full mip chain down to 1×1 for a square texture of the given side —
 *  what both backends allocate so trilinear minification has real levels. */
export const mipLevelsFor = (size: number): number =>
  Math.floor(Math.log2(size)) + 1

/**
 * Drive the paint-retry loop for a set of labels.
 *
 * `copy` attempts one label's element→texture copy and returns whether it
 * took. The loop retries the still-pending ones on animation frames until
 * all succeed, then stops touching the APIs entirely — the labels here are
 * fixed words that never change after they first land, so there is nothing
 * to re-sync. Retrying (rather than copying every frame) also keeps a
 * pre-paint copy from flooding the console with un-catchable validation
 * warnings.
 *
 * Returns a canceller so `dispose` can stop a loop still in flight.
 */
export type DriveLabelUploads = (
  labels: readonly unknown[],
  copy: (label: unknown) => boolean,
) => () => void

export const driveLabelUploads: DriveLabelUploads = (labels, copy) => {
  const pending = [...labels]
  let cancelled = false

  const flush = (): void => {
    if (cancelled) return
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (copy(pending[index])) pending.splice(index, 1)
    }
    if (pending.length > 0 && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flush)
    }
  }

  // Try once now (the element may already be painted), then on frames.
  if (pending.length > 0) {
    flush()
    if (pending.length > 0 && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flush)
    }
  }

  return () => { cancelled = true }
}
