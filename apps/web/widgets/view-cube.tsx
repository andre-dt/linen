// =====================================================================
// apps/web/widgets/view-cube.tsx — a FLOATING, draggable view cube.
//
// A CHAMFERED cube drawn in WebGL, turning with the camera so that its
// orientation is the readout: whichever facet faces you is the view you
// are in. Six faces, twelve bevelled edges and eight corners are
// twenty-six distinct things to click.
//
// WHY NOT A GRID, AND WHY NOT CSS
// -------------------------------
// This began as an unfolded grid of buttons. That broke when the centre
// cell had to carry both Front and Back: the circles around it named a
// corner that could belong to either, with nothing on screen to tell
// them apart.
//
// The replacement was a CSS 3D cube, and that cannot work either.
// `transform-style: preserve-3d` composites by DOCUMENT ORDER, not depth
// — measured directly, a quad at translateZ(-30px) paints over one at
// +30px. Six faces can be hand-sorted; twenty-six chamfered facets
// cannot. And a bevel's hit target would be a rectangle pretending to be
// a strip.
//
// Real geometry gives both for free: the depth buffer sorts, and picking
// is a ray cast against the very triangles that were drawn. The geometry
// and the picking live in @linen/viewer; this file is the control around
// them — placement, dragging, and the arrows.
//
// LAYOUT
// ------
//                   ⌒       ⌒           roll, both directions
//                      ▲
//               ◀  [ cube ]  ▶           step the camera
//                      ▼
//
// The arrows are fixed to the SCREEN — they mean "up on screen", not "up
// on the model" — while the cube itself turns.
//
// CLICK vs DRAG
// -------------
// The whole control is the drag handle. A press that moves less than a
// few pixels before release is a click; anything more is a drag, and the
// click that ends it is swallowed.
// =====================================================================

import { createSignal, createEffect, onMount, onCleanup, For } from "solid-js"
import { createCubeScene, type CubeScene, type CubeRegion } from "@linen/viewer"

/** A direction to look FROM, in the kernel's frame: X right, Y away at
 *  the Front view, Z up. */
export type ViewDirection = readonly [number, number, number]

/** Screen-space nudge: which way the flat arrows point. */
export interface ViewNudge {
  readonly x: -1 | 0 | 1
  readonly y: -1 | 0 | 1
}

/** The four flat arrows outside the cube. */
const NUDGES: readonly {
  readonly side: "up" | "down" | "left" | "right"
  readonly nudge: ViewNudge
  readonly label: string
}[] = [
  { side: "up", nudge: { x: 0, y: -1 }, label: "Rotate up" },
  { side: "down", nudge: { x: 0, y: 1 }, label: "Rotate down" },
  { side: "left", nudge: { x: -1, y: 0 }, label: "Rotate left" },
  { side: "right", nudge: { x: 1, y: 0 }, label: "Rotate right" },
]

/** The two curved arrows above the cube. */
const ROLLS: readonly {
  readonly steps: 1 | -1
  readonly label: string
  readonly side: "left" | "right"
}[] = [
  { steps: -1, label: "Rotate view anticlockwise", side: "left" },
  { steps: 1, label: "Rotate view clockwise", side: "right" },
]

/**
 * A curved arrow, drawn rather than typed.
 *
 * SVG because the arc and its head must line up exactly and scale with
 * the button; a text character renders at whatever size and weight the
 * platform's font happens to choose.
 */
function RollIcon(props: { readonly clockwise: boolean }) {
  return (
    <svg viewBox="0 0 32 20" aria-hidden="true" class="view-cube-roll-icon">
      <g transform={props.clockwise ? "scale(-1 1) translate(-32 0)" : undefined}>
        {/* A SHALLOW arc, not a near-closed loop: a full circle reads as
            "reload", which is the wrong verb entirely. */}
        <path
          d="M 28 17 A 15 15 0 0 0 8.5 8"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
        {/* The head, on the arc's leading end, along the tangent. */}
        <path d="M 3 4.5 L 12.5 6.5 L 7 13.5 Z" fill="currentColor" />
      </g>
    </svg>
  )
}

interface Position {
  readonly x: number
  readonly y: number
}

const STORAGE_KEY = "linen.view-cube.position"
/** Movement past this (in px) turns a press into a drag, not a click. */
const DRAG_THRESHOLD = 3
/** The cube's edge length. Mirrors --cube-size in the stylesheet.
 *
 *  118, up from 68. At 68 the face labels were a few pixels tall and the
 *  chamfered facets — the whole reason for the rewrite — were too small
 *  to aim at or even make out. Seen in a full page rather than a tight
 *  crop, it read as a smudge in the corner. */
const CUBE_SIZE = 118
/** Room around the cube for the arrows. Mirrors --cube-margin.
 *
 *  Tight to the cube on purpose: the arrows belong to it, and at the
 *  previous 30 against a 68 cube they floated in empty space, reading as
 *  four unrelated marks scattered round a small object. */
const CUBE_MARGIN = 24
const CONTROL_SIZE = CUBE_SIZE + CUBE_MARGIN * 2

const readPosition = (): Position | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Position>
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null
    return { x: parsed.x, y: parsed.y }
  } catch {
    // A corrupt or unavailable store is not worth failing over: fall
    // back to the default corner.
    return null
  }
}

const writePosition = (position: Position): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(position))
  } catch {
    // Private browsing, quota. The control still works; it just will not
    // remember where it was put.
  }
}

const clamp = (value: number, extent: number): number =>
  Math.max(0, Math.min(value, extent - CONTROL_SIZE))

const defaultPosition = (): Position => ({
  x: Math.max(0, window.innerWidth - CONTROL_SIZE - 16),
  // Below the account chip in the top row, not level with it. The roll
  // arrows sit at the control's very top edge, and at 72 they overlapped
  // the "Sign out" button.
  y: 104,
})

export interface ViewCubeProps {
  /** A face, edge or corner was clicked: look from this direction. */
  onPick?: (direction: ViewDirection) => void
  /** A flat arrow was clicked: step the camera one notch. */
  onNudge?: (nudge: ViewNudge) => void
  /** A curved arrow was clicked: roll the picture. */
  onRoll?: (steps: number) => void
  /** The camera's orientation, so the cube can mirror it. Radians. */
  azimuth?: number
  elevation?: number
  rollAngle?: number
}

export function ViewCube(props: ViewCubeProps) {
  const [position, setPosition] = createSignal<Position>(
    readPosition() ?? defaultPosition(),
  )
  const [dragging, setDragging] = createSignal(false)

  const onResize = (): void => {
    const current = position()
    setPosition({
      x: clamp(current.x, window.innerWidth),
      y: clamp(current.y, window.innerHeight),
    })
  }
  onMount(() => window.addEventListener("resize", onResize))
  onCleanup(() => window.removeEventListener("resize", onResize))

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const origin = position()
    const startX = event.clientX
    const startY = event.clientY
    let moved = false

    // Tracked on WINDOW rather than through setPointerCapture: a
    // re-render mid-gesture can swap the node out, taking its capture
    // and listeners with it, and the drag would die after one pixel.
    const onMove = (move: PointerEvent): void => {
      const deltaX = move.clientX - startX
      const deltaY = move.clientY - startY
      if (!moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return
      moved = true
      setDragging(true)
      setPosition({
        x: clamp(origin.x + deltaX, window.innerWidth),
        y: clamp(origin.y + deltaY, window.innerHeight),
      })
    }
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      if (moved) {
        writePosition(position())
        // Cleared AFTER the click event would fire, so the click that
        // ends a drag is swallowed rather than changing the view.
        setTimeout(() => setDragging(false), 0)
      }
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  // --- the GL cube -------------------------------------------------------
  // Held outside the reactive graph: it is redrawn from an animation
  // frame, and a signal would schedule DOM work for state no DOM node
  // shows.
  let canvas!: HTMLCanvasElement
  let cube: CubeScene | null = null
  const [failed, setFailed] = createSignal(false)

  onMount(() => {
    try {
      cube = createCubeScene(canvas)
    } catch {
      // No WebGL2. The arrows still work, so the control degrades to
      // those rather than disappearing.
      setFailed(true)
      return
    }
    cube.resize(CUBE_SIZE, window.devicePixelRatio)

    let frame = 0
    const draw = (): void => {
      cube?.render(
        props.azimuth ?? 0,
        props.elevation ?? 0,
        props.rollAngle ?? 0,
      )
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)

    onCleanup(() => {
      cancelAnimationFrame(frame)
      cube?.dispose()
      cube = null
    })
  })

  // Device pixel ratio can change when a window moves between displays;
  // without this the cube would stay at the old resolution.
  createEffect(() => {
    const onDisplayChange = (): void => cube?.resize(CUBE_SIZE, window.devicePixelRatio)
    window.addEventListener("resize", onDisplayChange)
    onCleanup(() => window.removeEventListener("resize", onDisplayChange))
  })

  /** Canvas-local coordinates for a pointer event. */
  const localPoint = (event: PointerEvent | MouseEvent): [number, number] => {
    const bounds = canvas.getBoundingClientRect()
    return [event.clientX - bounds.left, event.clientY - bounds.top]
  }

  const onCubeMove = (event: PointerEvent): void => {
    if (!cube) return
    // Nothing lit while dragging: the cursor is moving the control, not
    // aiming at a facet.
    if (dragging()) {
      cube.hovered = null
      return
    }
    const [x, y] = localPoint(event)
    cube.hovered = cube.pick(x, y)
  }

  const onCubeLeave = (): void => {
    if (cube) cube.hovered = null
  }

  const onCubeClick = (event: MouseEvent): void => {
    // A release that merely ends a drag is not a click.
    if (dragging() || !cube) return
    const [x, y] = localPoint(event)
    const region = cube.pick(x, y)
    if (region) props.onPick?.(region.direction)
  }

  return (
    <div
      class="view-cube-slot"
      style={{ left: `${position().x}px`, top: `${position().y}px` }}
      onPointerDown={onPointerDown}
    >
      <canvas
        ref={canvas}
        class="view-cube-canvas"
        classList={{ failed: failed() }}
        style={{ width: `${CUBE_SIZE}px`, height: `${CUBE_SIZE}px` }}
        onPointerMove={onCubeMove}
        onPointerLeave={onCubeLeave}
        onClick={onCubeClick}
      />

      <For each={NUDGES}>
        {(control) => (
          <button
            class="view-cube-nudge"
            data-side={control.side}
            title={control.label}
            aria-label={control.label}
            onClick={() => {
              if (dragging()) return
              props.onNudge?.(control.nudge)
            }}
          />
        )}
      </For>

      <For each={ROLLS}>
        {(control) => (
          <button
            class="view-cube-roll"
            data-side={control.side}
            title={control.label}
            aria-label={control.label}
            onClick={() => {
              if (dragging()) return
              props.onRoll?.(control.steps)
            }}
          >
            <RollIcon clockwise={control.steps > 0} />
          </button>
        )}
      </For>
    </div>
  )
}
