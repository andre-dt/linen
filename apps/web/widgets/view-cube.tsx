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
  createConfiguredCubeScene,
  type CubeScene, type CubeRegion,
} from "@linen/viewer"
import { useCamera } from "../render/camera-provider"
import { useRenderTick } from "../render/render-loop"

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

// The cube takes NO props for its data: it reads the live camera from
// context (useCamera) to mirror its orientation, and drives that same
// camera on a click (camera.lookFrom). The only thing left that could be a
// prop — where it floats — it owns itself (dragged + persisted). So it is
// a self-contained behaviour: mount it under <CameraProvider> and it works.
export function ViewCube() {
  const stored = readPosition() ?? defaultPosition()
  const [position, setPosition] = createSignal<Position>({
    // Clamp on the FIRST read too, not only on resize: a position saved at
    // one browser page-zoom is out of bounds at a higher one (200% halves
    // the CSS viewport), which parked the control off-screen until the
    // window happened to resize.
    x: clamp(stored.x, window.innerWidth),
    y: clamp(stored.y, window.innerHeight),
  })
  const [dragging, setDragging] = createSignal(false)

  const onResize = (): void => {
    const current = position()
    setPosition({
      x: clamp(current.x, window.innerWidth),
      y: clamp(current.y, window.innerHeight),
    })
  }
  onMount(() => {
    window.addEventListener("resize", onResize)
    // Browser PAGE zoom changes the visual viewport without always firing a
    // window resize; visualViewport reports it so the control follows the
    // shrinking viewport back into view.
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
  const camera = useCamera()

  onMount(() => {
    let cancelled = false

    // The backend is chosen by CONFIG (?renderer= / VITE_RENDERER / default
    // 'auto'), not hard-coded. Both backends implement the same CubeScene,
    // so the widget draws the cube identically whichever one it got.
    // Backend creation is async (WebGPU device acquisition), so mount kicks
    // it off and the shared render loop draws it once it lands.
    void (async () => {
      try {
        cube = await createConfiguredCubeScene(canvas)
      } catch {
        setFailed(true)
        return
      }
      if (cancelled) { cube.dispose(); cube = null; return }
      cube.resize(CUBE_SIZE, window.devicePixelRatio)
    })()

    onCleanup(() => {
      cancelled = true
      cube?.dispose()
      cube = null
    })
  })

  // Draw on the SHARED render loop, reading the LIVE camera the model just
  // advanced this same frame — so the cube can never lag the view the way
  // the old poll-into-a-signal bridge could. No camera yet (scene still
  // starting) or no cube yet (backend still loading) simply skips the frame.
  useRenderTick(() => {
    const view = camera()
    if (!cube || !view) return
    cube.render(view.azimuth, view.elevation, view.rollAngle)
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

  // The cube floats OVER the CAD viewport, so it is the topmost hit target
  // and swallows every event in its square — including the right-drag that
  // ORBITS the camera and the wheel that zooms. Those are the viewport's, not
  // the cube's: only the LEFT button belongs to the cube (hover + snap-to-
  // view). So any non-left camera gesture is forwarded to the viewport
  // underneath by re-dispatching a clone of the event there. The cube and the
  // viewport are siblings (the cube is position:fixed), so nothing bubbles
  // between them on its own.
  //
  // The target is the INTERACTION OVERLAY, not `canvas.viewport`. The canvas
  // carries only pixels; every pointer handler lives on the transparent
  // `div.viewport-interaction` coincident with it (see viewport.tsx). Aimed
  // at the canvas, a forwarded right-drag lands on an element with no
  // listeners and vanishes — the cube reads as a dead region for orbit and
  // pan, and the release surfaces the browser's own context menu.
  //
  // Only the opening pointerdown needs forwarding: the overlay calls
  // setPointerCapture for camera gestures, so the browser routes the rest of
  // the drag straight to it, cube or no cube.
  const viewportBeneath = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(".viewport-interaction")

  const forwardToViewport = (event: PointerEvent | WheelEvent | MouseEvent): void => {
    const target = viewportBeneath()
    if (!target) return
    // Clone with the SAME kind and coordinates so the viewport's gesture
    // detector reads the identical button/position it would from a direct
    // event. PointerEvent for pointer*, WheelEvent for wheel, MouseEvent for
    // contextmenu.
    const Ctor = event.constructor as {
      new (type: string, init: unknown): Event
    }
    target.dispatchEvent(new Ctor(event.type, event))
  }

  const onCubeMove = (event: PointerEvent): void => {
    // A right/middle drag over the cube is the camera moving; keep feeding it
    // to the viewport and do not light facets.
    if (event.buttons > 1 || (event.buttons & 2) !== 0) {
      if (cube) cube.hovered = null
      forwardToViewport(event)
      return
    }
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

  const onCubeDown = (event: PointerEvent): void => {
    // Non-left press starts a camera gesture: hand it to the viewport.
    if (event.button !== 0) {
      forwardToViewport(event)
    }
  }

  const onCubeUp = (event: PointerEvent): void => {
    if (event.button !== 0) forwardToViewport(event)
  }

  const onCubeWheel = (event: WheelEvent): void => {
    // Zoom belongs to the camera even when the pointer is over the cube.
    forwardToViewport(event)
  }

  const onCubeContextMenu = (event: MouseEvent): void => {
    // The right button orbits; its native menu must not appear over the cube
    // any more than over the viewport.
    event.preventDefault()
  }

  const onCubeClick = (event: MouseEvent): void => {
    // Only the LEFT button snaps a view. A release that merely ends a drag,
    // or a non-left click, is not a snap.
    if (event.button !== 0 || dragging() || !cube) return
    const [x, y] = localPoint(event)
    const region = cube.pick(x, y)
    // Straight to the camera from context: the cube's regions are poses
    // (faces, corners), and lookFrom resolves any of them. No callback up
    // to the screen and back — the cube owns this interaction end to end.
    if (region) camera()?.lookFrom(region.direction)
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
        onPointerDown={onCubeDown}
        onPointerMove={onCubeMove}
        onPointerUp={onCubeUp}
        onPointerLeave={onCubeLeave}
        onWheel={onCubeWheel}
        onContextMenu={onCubeContextMenu}
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
