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

import { createSignal, createEffect, onMount, onCleanup } from "solid-js"
import {
  createBackend, createCubeSceneGpu,
  type CubeSceneGpu, type CubeRegion, type WebGpuBackend,
} from "@linen/viewer"

/** A direction to look FROM, in the kernel's frame: X right, Y away at
 *  the Front view, Z up. */
export type ViewDirection = readonly [number, number, number]

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
const CUBE_SIZE = 160
/** A little breathing room around the cube. Mirrors --cube-margin.
 *
 *  The arrows this once made space for are gone — the control is just the
 *  cube now — so this is only the gap that keeps it off the very edge of
 *  the viewport when parked in a corner. */
const CUBE_MARGIN = 8
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
  let cube: CubeSceneGpu | null = null
  const [failed, setFailed] = createSignal(false)

  onMount(() => {
    let frame = 0
    let backend: WebGpuBackend | null = null
    let cancelled = false

    // WebGPU only — no WebGL fallback. Backend creation is async (adapter +
    // device), so mount kicks it off and wires the loop once it lands.
    void (async () => {
      let created: Awaited<ReturnType<typeof createBackend>>
      try {
        created = await createBackend(canvas, "webgpu")
      } catch {
        setFailed(true)
        return
      }
      // createBackend falls through to WebGL2 when WebGPU is unavailable;
      // the cube is WebGPU-only, so reject anything else rather than crash
      // on a backend with no GPUDevice.
      if (created.kind !== "webgpu") {
        setFailed(true)
        created.dispose()
        return
      }
      backend = created as WebGpuBackend
      if (cancelled) { backend.dispose(); return }

      cube = createCubeSceneGpu(
        canvas, backend.device, backend.context, backend.format,
      )
      cube.resize(CUBE_SIZE, window.devicePixelRatio)

      const draw = (): void => {
        cube?.render(
          props.azimuth ?? 0,
          props.elevation ?? 0,
          props.rollAngle ?? 0,
        )
        frame = requestAnimationFrame(draw)
      }
      frame = requestAnimationFrame(draw)
    })()

    onCleanup(() => {
      cancelled = true
      cancelAnimationFrame(frame)
      cube?.dispose()
      cube = null
      backend?.dispose()
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
      {/* Visible reason when WebGPU is unavailable, instead of the cube
          silently vanishing. The cube is WebGPU-only by design. */}
      {failed() && (
        <div
          class="view-cube-failed"
          style={{ width: `${CUBE_SIZE}px`, height: `${CUBE_SIZE}px` }}
        >
          WebGPU unavailable
        </div>
      )}
    </div>
  )
}
