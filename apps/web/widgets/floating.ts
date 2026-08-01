// =====================================================================
// apps/web/widgets/floating.ts — DRAG A CONTROL AND REMEMBER WHERE.
//
// Extracted from the view cube, which grew this behaviour first. The
// command panel needs the identical thing — free placement that survives
// a reload — and two copies of a gesture this fiddly would drift apart
// on the first fix applied to only one of them.
//
// What it owns: the position signal, the pointer gesture, clamping to the
// viewport, and the localStorage round trip. What it does NOT own: how
// the control looks, or what a click on it means. The caller spreads
// `handleProps` onto whichever node is the drag HANDLE — the whole
// control for the cube, just the header for a panel.
//
// CLICK vs DRAG
// -------------
// A press that moves less than a few pixels before release is a click and
// is left alone; anything more is a drag, and `dragging()` stays true
// until after the click event would have fired, so the caller can swallow
// the click that merely ended a drag.
// =====================================================================

import { createSignal, onMount, onCleanup, type Accessor } from "solid-js"

export interface Position {
  readonly x: number
  readonly y: number
}

/** Movement past this (in px) turns a press into a drag, not a click. */
const DRAG_THRESHOLD = 3

export interface FloatingOptions {
  /** localStorage key. Distinct per control, or they would share a spot. */
  readonly storageKey: string
  /** Where the control sits before it has ever been dragged. Called
   *  lazily so it can read the viewport size at mount rather than at
   *  module load, when the window may not be sized yet. */
  readonly initial: () => Position
  /** The control's footprint, used to keep it inside the viewport.
   *  A function, not a constant: a panel's height depends on its
   *  content and changes as the user walks the steps. */
  readonly size: () => { readonly width: number; readonly height: number }
}

export interface Floating {
  readonly position: Accessor<Position>
  /** True from the moment a press becomes a drag until just after the
   *  click it would produce. */
  readonly dragging: Accessor<boolean>
  /** Spread onto the drag handle. */
  readonly handleProps: {
    readonly onPointerDown: (event: PointerEvent) => void
  }
}

const readPosition = (key: string): Position | null => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Position>
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null
    return { x: parsed.x, y: parsed.y }
  } catch {
    // A corrupt or unavailable store is not worth failing over: fall back
    // to the default corner.
    return null
  }
}

const writePosition = (key: string, position: Position): void => {
  try {
    localStorage.setItem(key, JSON.stringify(position))
  } catch {
    // Private browsing, quota. The control still works; it just will not
    // remember where it was put.
  }
}

/** Keeps a coordinate inside the viewport, leaving the control's own
 *  extent visible. Never negative: pinned to the left/top edge is better
 *  than parked off-screen, which is unrecoverable without clearing the
 *  store. */
const clamp = (value: number, extent: number, control: number): number =>
  Math.max(0, Math.min(value, extent - control))

export const createFloating = (options: FloatingOptions): Floating => {
  const clamped = (candidate: Position): Position => {
    const { width, height } = options.size()
    return {
      x: clamp(candidate.x, window.innerWidth, width),
      y: clamp(candidate.y, window.innerHeight, height),
    }
  }

  // Clamp on the FIRST read too, not only on resize: a position saved at
  // one browser page-zoom is out of bounds at a higher one (200% halves
  // the CSS viewport), which parked the control off-screen until the
  // window happened to resize.
  const [position, setPosition] = createSignal<Position>(
    clamped(readPosition(options.storageKey) ?? options.initial()),
  )
  const [dragging, setDragging] = createSignal(false)

  /** Every write goes through here, so nothing can be placed unclamped.
   *  The updater form (`() => value`) is required rather than stylistic:
   *  Solid's setter treats a bare value as the new state only when it is
   *  not callable, and typing it as the updater keeps that unambiguous. */
  const place = (next: Position): void => { setPosition(() => clamped(next)) }

  const onResize = (): void => place(position())

  onMount(() => {
    window.addEventListener("resize", onResize)
    // Browser PAGE zoom changes the visual viewport without always firing
    // a window resize; visualViewport reports it so the control follows
    // the shrinking viewport back into view.
    window.visualViewport?.addEventListener("resize", onResize)
  })
  onCleanup(() => {
    window.removeEventListener("resize", onResize)
    window.visualViewport?.removeEventListener("resize", onResize)
  })

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const origin = position()
    const startX = event.clientX
    const startY = event.clientY
    let moved = false

    // Tracked on WINDOW rather than through setPointerCapture: a
    // re-render mid-gesture can swap the node out, taking its capture and
    // listeners with it, and the drag would die after one pixel.
    const onMove = (move: PointerEvent): void => {
      const deltaX = move.clientX - startX
      const deltaY = move.clientY - startY
      if (!moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return
      moved = true
      setDragging(true)
      place({ x: origin.x + deltaX, y: origin.y + deltaY })
    }
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      if (moved) {
        writePosition(options.storageKey, position())
        // Cleared AFTER the click event would fire, so the click that
        // ends a drag is swallowed rather than acting on the control.
        setTimeout(() => setDragging(false), 0)
      }
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  return { position, dragging, handleProps: { onPointerDown } }
}
