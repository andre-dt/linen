// =====================================================================
// apps/web/gestures.tsx — GESTURE RECOGNITION.
//
// Turns raw pointer events into NAMED GESTURES — "orbit", "pan", "select"
// — and keeps the mapping from buttons to gestures in exactly one place.
//
// WHY THIS IS ITS OWN LAYER
// -------------------------
// Before this, the viewport read `event.button === 1 || event.shiftKey`
// inline, in three handlers that had to agree. They drifted: pointerdown
// decided pan on shift, pointerup still tested shift to reject a click,
// and neither matched what the app actually wanted. A binding spread
// across three conditionals cannot be checked, changed, or rebound.
//
// So the split is:
//
//   GestureProvider   owns the BINDING — which button means which
//                     gesture. One table, one place to change it, and
//                     the natural home for user-configurable controls.
//
//   GestureDetector   owns the RECOGNITION — pointer capture, drag vs
//                     click, movement deltas. It knows nothing about
//                     cameras or sketches; it reports what the user did.
//
// The consumer receives intent ("the user is orbiting by dx, dy") and
// never touches a button number.
//
// THE DEFAULT BINDING IS ONSHAPE'S
// --------------------------------
//   left            select
//   right           orbit
//   ctrl + right    pan
//   middle          pan
//   wheel           zoom
//
// The load-bearing part is that LEFT NEVER MOVES THE CAMERA. In a CAD
// viewport left-drag is selection; a tool that steals it makes you change
// grip between picking and looking, which is the difference most felt
// between a CAD viewport and a 3D viewer.
// =====================================================================

import {
  createContext, useContext, createSignal, type JSX, type Accessor,
} from "solid-js"

// =====================================================================
// 1. GESTURES
// =====================================================================

export type GestureKind = "orbit" | "pan" | "select"

/** A drag in progress, reported per move. */
export interface DragGesture {
  readonly kind: "orbit" | "pan"
  /** Movement since the last report, in CSS pixels. */
  readonly deltaX: number
  readonly deltaY: number
}

/** A click that did not drag: a selection, at a canvas-relative point. */
export interface ClickGesture {
  readonly x: number
  readonly y: number
  /** Adds to a selection rather than replacing it. */
  readonly additive: boolean
}

/** The cursor moving with no button held. Drives hover and rubber bands. */
export interface HoverGesture {
  readonly x: number
  readonly y: number
}

// =====================================================================
// 2. BINDING
// =====================================================================

export interface GestureBinding {
  /** Which gesture a press starts, or null to ignore the press. */
  resolve(event: PointerEvent): GestureKind | null
  /** How far the pointer may travel and still count as a click. */
  readonly clickSlop: number
}

const LEFT = 0
const MIDDLE = 1
const RIGHT = 2

/** Onshape's mapping. See the header for why left is reserved. */
export const ONSHAPE_BINDING: GestureBinding = {
  resolve(event) {
    if (event.button === LEFT) return "select"
    // Ctrl promotes orbit to pan — checked BEFORE plain right, or the
    // modifier would never be reached.
    if (event.button === RIGHT) return event.ctrlKey ? "pan" : "orbit"
    if (event.button === MIDDLE) return "pan"
    return null
  },
  clickSlop: 4,
}

const GestureContext = createContext<Accessor<GestureBinding>>(() => ONSHAPE_BINDING)

/**
 * Supplies the binding to every detector beneath it. Swapping in a
 * different mapping — a user preference, a "SolidWorks controls" option —
 * is changing this one value, with no detector or consumer aware of it.
 */
export function GestureProvider(props: {
  binding?: GestureBinding
  children: JSX.Element
}) {
  const [binding] = createSignal<GestureBinding>(props.binding ?? ONSHAPE_BINDING)
  return (
    <GestureContext.Provider value={binding}>
      {props.children}
    </GestureContext.Provider>
  )
}

export const useGestureBinding = (): Accessor<GestureBinding> =>
  useContext(GestureContext)

// =====================================================================
// 3. DETECTOR
// =====================================================================

export interface GestureDetectorProps {
  /** A drag step. Fires many times per gesture. */
  onDrag?: (gesture: DragGesture) => void
  /** A press that ended without dragging. */
  onClick?: (gesture: ClickGesture) => void
  /** A move with no button held. */
  onHover?: (gesture: HoverGesture) => void
  /** The pointer left the surface: drop any hover state. */
  onLeave?: () => void
  onDoubleClick?: () => void
  /** Wheel delta, already sign-corrected for zoom, plus the cursor's
   *  position in CSS pixels relative to the surface CENTER (x right, y up),
   *  so the zoom can pull toward the cursor. */
  onZoom?: (delta: number, focal: readonly [number, number]) => void
  /** A drag started / ended, for a grabbing cursor or suppressed hover. */
  onDragStart?: (kind: "orbit" | "pan") => void
  onDragEnd?: () => void
  children: (handlers: GestureHandlers) => JSX.Element
}

/** Spread onto the element that should receive the gestures. */
export interface GestureHandlers {
  onPointerDown: (event: PointerEvent) => void
  onPointerMove: (event: PointerEvent) => void
  onPointerUp: (event: PointerEvent) => void
  onPointerCancel: (event: PointerEvent) => void
  onPointerLeave: () => void
  onDblClick: () => void
  onWheel: (event: WheelEvent) => void
  onContextMenu: (event: MouseEvent) => void
}

/**
 * Recognises gestures on whatever element its child renders.
 *
 * Uses a render prop rather than wrapping the child in a div: the target
 * is a <canvas> whose size the renderer measures, and an extra wrapper
 * would put a layout box between it and the slot that sizes it.
 */
export function GestureDetector(props: GestureDetectorProps) {
  const binding = useGestureBinding()

  // Deliberately plain variables, not signals. These change on every
  // mouse move; routing them through the reactive graph would schedule
  // DOM work sixty times a second for state no DOM node reads.
  let active: GestureKind | null = null
  let lastX = 0
  let lastY = 0
  let travelled = 0

  // ALT-CONSTRAINED ORBIT. Holding Alt as an orbit begins locks it to a
  // single axis: the dominant direction of the first bit of travel picks
  // azimuth (a mostly-horizontal start) or elevation (a mostly-vertical
  // one), and the other axis is suppressed for the rest of the drag.
  // Zoom is a separate gesture, so it stays free while the lock holds.
  //
  // `armed` is Alt's state sampled at the DRAG START (the axis is chosen
  // at the start, per the interaction design — pressing Alt mid-drag does
  // not arm it). `axisLock` is null until enough travel has accumulated
  // to name the axis with confidence.
  let lockArmed = false
  let axisLock: "azimuth" | "elevation" | null = null
  // Travel accumulated while still deciding which axis to lock.
  let lockPendingX = 0
  let lockPendingY = 0

  /** How much drag (CSS px, summed on both axes) to see before committing
   *  to an axis — enough that a near-diagonal flick does not lock the
   *  wrong way on its first pixel. */
  const LOCK_DECIDE_THRESHOLD = 6

  const localPoint = (event: PointerEvent): readonly [number, number] => {
    const target = event.currentTarget as HTMLElement | null
    if (!target) return [event.clientX, event.clientY]
    const rect = target.getBoundingClientRect()
    return [event.clientX - rect.left, event.clientY - rect.top]
  }

  const handlers: GestureHandlers = {
    onPointerDown(event) {
      const kind = binding().resolve(event)
      if (!kind) return

      active = kind
      lastX = event.clientX
      lastY = event.clientY
      travelled = 0

      // Arm the axis lock only for an orbit begun with Alt down. Reset
      // every gesture so a previous lock never leaks into the next drag.
      lockArmed = kind === "orbit" && event.altKey
      axisLock = null
      lockPendingX = 0
      lockPendingY = 0

      // Only a camera gesture captures. Capturing on select too would
      // swallow the pointerup that a click needs to be recognised
      // against the element actually under the cursor.
      if (kind !== "select") {
        const target = event.currentTarget
        target instanceof HTMLElement && target.setPointerCapture(event.pointerId)
        props.onDragStart?.(kind)
      }
    },

    onPointerMove(event) {
      if (!active) {
        const [x, y] = localPoint(event)
        props.onHover?.({ x, y })
        return
      }

      const deltaX = event.clientX - lastX
      const deltaY = event.clientY - lastY
      lastX = event.clientX
      lastY = event.clientY
      travelled += Math.abs(deltaX) + Math.abs(deltaY)

      // A select that moves is a drag the consumer has not asked for
      // (marquee selection, later). Track the distance so it can be
      // rejected as a click, but report nothing.
      if (active === "select") return

      // Alt-constrained orbit: decide the axis once, then suppress the
      // other. Only ever engages for an orbit armed at its start.
      let reportX = deltaX
      let reportY = deltaY
      if (lockArmed && active === "orbit") {
        if (!axisLock) {
          // Still deciding: pool the travel until it is unambiguous, and
          // report nothing yet so the pre-lock jitter does not move the
          // camera off the chosen line.
          lockPendingX += deltaX
          lockPendingY += deltaY
          if (
            Math.abs(lockPendingX) + Math.abs(lockPendingY) <
            LOCK_DECIDE_THRESHOLD
          ) {
            return
          }
          axisLock =
            Math.abs(lockPendingX) >= Math.abs(lockPendingY)
              ? "azimuth"
              : "elevation"
          // Fold the pooled travel into this first locked report, so the
          // camera picks up exactly where the finger already is.
          reportX = lockPendingX
          reportY = lockPendingY
        }
        // Suppress the off-axis component for the whole drag.
        if (axisLock === "azimuth") reportY = 0
        else reportX = 0
      }

      props.onDrag?.({ kind: active, deltaX: reportX, deltaY: reportY })
    },

    onPointerUp(event) {
      const finished = active
      active = null

      const target = event.currentTarget
      if (target instanceof HTMLElement && target.hasPointerCapture?.(event.pointerId)) {
        target.releasePointerCapture(event.pointerId)
      }

      if (!finished) return
      if (finished !== "select") {
        props.onDragEnd?.()
        return
      }

      // A click is a select that stayed put. Past the slop it was a drag,
      // and firing a selection there would select whatever the cursor
      // happened to end over.
      if (travelled > binding().clickSlop) return
      const [x, y] = localPoint(event)
      props.onClick?.({ x, y, additive: event.shiftKey })
    },

    onPointerCancel(event) {
      const wasDragging = active !== null && active !== "select"
      active = null
      const target = event.currentTarget
      if (target instanceof HTMLElement && target.hasPointerCapture?.(event.pointerId)) {
        target.releasePointerCapture(event.pointerId)
      }
      if (wasDragging) props.onDragEnd?.()
    },

    onPointerLeave() {
      // Only hover state is dropped. A drag survives leaving the element
      // because it holds pointer capture — releasing here would stop an
      // orbit the moment it crossed the edge.
      if (active) return
      props.onLeave?.()
    },

    onDblClick() {
      props.onDoubleClick?.()
    },

    onWheel(event) {
      event.preventDefault()
      // Cursor position relative to the surface center, expressed in units
      // of HALF the visible HEIGHT — the camera's own vertical unit, so it
      // can convert to world exactly and hold the point under the cursor.
      // Both axes are divided by the same half-height: world-per-pixel is
      // uniform (the projection is height-driven and the aspect matches the
      // canvas), so a pixel is the same world distance either way. Y is
      // flipped from the DOM's downward axis to the camera's screen-up.
      const target = event.currentTarget as HTMLElement | null
      let focalX = 0
      let focalY = 0
      if (target) {
        const rect = target.getBoundingClientRect()
        const halfHeight = rect.height / 2
        if (halfHeight > 0) {
          focalX = (event.clientX - rect.left - rect.width / 2) / halfHeight
          focalY = (halfHeight - (event.clientY - rect.top)) / halfHeight
        }
      }
      props.onZoom?.(event.deltaY, [focalX, focalY])
    },

    onContextMenu(event) {
      // The right button orbits, so its menu has to go — otherwise every
      // orbit ends in a context menu.
      event.preventDefault()
    },
  }

  return <>{props.children(handlers)}</>
}
