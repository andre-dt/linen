// =====================================================================
// apps/web/viewport.tsx — the canvas.
//
// The single place where the reactive world meets the imperative one.
//
// The canvas element is created by Solid, but everything drawn on it is
// owned by the scene: buffers, camera, draw calls. No signal reads
// anything the renderer writes.
//
// That boundary is deliberate. A signal driving buffer uploads would
// re-run on every unrelated state change — hovering a toolbar button
// would schedule a GPU upload — and the frame budget would go with it.
// =====================================================================

import { onMount, onCleanup, createSignal, Show, createEffect } from "solid-js"
import { createBackend, createScene, PLANE_EXTENT } from "@linen/viewer"
import type { Backend, Scene, PlaneHit, DatumPlaneId } from "@linen/viewer"

interface ViewportProps {
  /** True while a step is asking for a plane: the datum planes appear
   *  and become clickable. Driven by the panel's metadata, so no feature
   *  needs its own viewport code. */
  readonly pickingPlane?: boolean
  /** The plane already chosen, kept lit. A view name — "top", "front". */
  readonly selectedPlane?: string | null
  /** A datum plane was clicked. Carries where on it, in its own
   *  two-dimensional coordinates, which is what a sketch click needs. */
  readonly onPickPlane?: (hit: PlaneHit) => void
  /** Set once the scene exists, so the parent can drive the camera. */
  readonly onScene?: (scene: Scene | null) => void
}

export function Viewport(props: ViewportProps) {
  let canvas!: HTMLCanvasElement
  const [failure, setFailure] = createSignal<string | null>(null)
  const [backend, setBackend] = createSignal<"webgpu" | "webgl2" | null>(null)
  // Held outside the reactive graph on purpose: the render loop reads it
  // every frame, and a signal would schedule DOM work sixty times a
  // second for state no DOM node displays.
  let scene: Scene | null = null

  onMount(async () => {
    let device: Backend
    try {
      // WebGPU when available, WebGL2 otherwise. A missing WebGPU is the
      // expected path on older browsers, not an error worth surfacing.
      device = await createBackend(canvas)
      setBackend(device.kind)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "no usable graphics backend")
      return
    }

    const active = createScene(device)
    scene = active
    props.onScene?.(active)

    // Frame the datum planes, so an empty part opens looking at the
    // things it can actually be started from rather than at nothing.
    active.camera.fit({
      minimum: [-PLANE_EXTENT, -PLANE_EXTENT, -PLANE_EXTENT],
      maximum: [PLANE_EXTENT, PLANE_EXTENT, PLANE_EXTENT],
    })
    active.camera.viewFrom("isometric")

    // --- render loop ---------------------------------------------------
    // Driven by the browser, never by a signal.
    let frame = 0
    const draw = () => {
      active.render()
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)

    // --- sizing ---------------------------------------------------------
    // Device pixel ratio matters: a CAD viewport at half resolution looks
    // broken in a way users read as low quality rather than as a setting.
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      active.resize(width, height, window.devicePixelRatio)
    })
    observer.observe(canvas)

    onCleanup(() => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      scene?.dispose()
      device.dispose()
      scene = null
      props.onScene?.(null)
    })
  })

  // The ONE place signals touch the scene: publishing intent. Which
  // plane is lit is panel state, so it has to cross the boundary — but
  // it crosses as two scalar writes per change, not as a redraw.
  createEffect(() => {
    if (!scene) return
    scene.planes.visible = props.pickingPlane === true
    scene.planes.selected = (props.selectedPlane as DatumPlaneId | null) ?? null
    // Nothing under the cursor until the pointer moves again: a stale
    // hover would stay lit after the planes are re-shown.
    if (!props.pickingPlane) scene.planes.hovered = null
  })

  /** Cursor position relative to the canvas, in CSS pixels — the space
   *  the ray cast expects. */
  const canvasPoint = (event: PointerEvent): readonly [number, number] => {
    const rect = canvas.getBoundingClientRect()
    return [event.clientX - rect.left, event.clientY - rect.top]
  }

  // --- pointer ----------------------------------------------------------
  // Picking is driven by the ACTIVE PANEL FIELD: it declares what it
  // accepts, so an "up to face" step cannot select an edge by accident.
  // That rule lives in metadata, not in this file.

  // Camera control is imperative and deliberately outside the reactive
  // graph: it fires on every mouse move, and routing that through
  // signals would schedule DOM work sixty times a second for state no
  // DOM node reads.
  let dragging: "orbit" | "pan" | null = null
  let lastX = 0
  let lastY = 0
  // How far the pointer travelled while down. A click that orbited is a
  // camera move, not a selection — without this, every orbit that ends
  // over a plane would also select it.
  let travelled = 0
  const CLICK_SLOP = 4

  const onPointerDown = (event: PointerEvent) => {
    if (!scene) return

    // Middle button or shift-drag pans; left button orbits. Matches
    // what every CAD tool does, so the muscle memory carries over.
    dragging = event.button === 1 || event.shiftKey ? "pan" : "orbit"
    lastX = event.clientX
    lastY = event.clientY
    travelled = 0
    event.currentTarget instanceof HTMLElement &&
      event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!scene) return

    if (!dragging) {
      // Hovering: ray cast so the plane under the cursor lights up
      // before it is clicked. Only while a step is asking for one —
      // otherwise the planes are not even drawn.
      if (props.pickingPlane) {
        const [x, y] = canvasPoint(event)
        scene.planes.hovered = scene.planes.pick(x, y)?.plane.id ?? null
      }
      return
    }

    const deltaX = event.clientX - lastX
    const deltaY = event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY
    travelled += Math.abs(deltaX) + Math.abs(deltaY)

    if (dragging === "orbit") {
      scene.camera.orbit(-deltaX * 0.008, deltaY * 0.008)
    } else {
      scene.camera.pan(deltaX, deltaY)
    }
  }

  const onPointerUp = (event: PointerEvent) => {
    const wasDragging = dragging
    dragging = null
    event.currentTarget instanceof HTMLElement &&
      event.currentTarget.releasePointerCapture(event.pointerId)

    // A click, not a drag: hit-test whatever the step is asking for.
    if (!scene || travelled > CLICK_SLOP || wasDragging === "pan") return
    if (!props.pickingPlane) return

    const [x, y] = canvasPoint(event)
    const hit = scene.planes.pick(x, y)
    if (hit) props.onPickPlane?.(hit)
  }

  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    scene?.camera.dolly(event.deltaY)
  }

  return (
    <Show
      when={!failure()}
      fallback={
        <div class="viewport-failure">
          <p>{failure()}</p>
          <p class="viewport-failure-hint">
            Linen needs WebGPU or WebGL2.
          </p>
        </div>
      }
    >
      <canvas
        ref={canvas}
        class="viewport"
        data-backend={backend()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      />
    </Show>
  )
}


