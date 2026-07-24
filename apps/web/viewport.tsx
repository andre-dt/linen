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

import { onMount, onCleanup, createSignal, Show } from "solid-js"
import { createBackend, createScene, syntheticBox } from "@linen/viewer"
import type { Backend, Scene, PickKind } from "@linen/viewer"
import type { Session } from "./session"

interface ViewportProps {
  readonly session: Session
}

export function Viewport(props: ViewportProps) {
  let canvas!: HTMLCanvasElement
  const [failure, setFailure] = createSignal<string | null>(null)
  const [backend, setBackend] = createSignal<"webgpu" | "webgl2" | null>(null)

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

    // Kept off the reactive graph on purpose.
    const scene = createScene(device)
    props.session.scene = scene

    // Until the kernel is wired up, draw a box in the real wire format.
    // It exercises the actual path — decode, upload, shade, resize — so
    // what works here keeps working once meshes arrive from the server.
    const drawable = scene.upload(1 as never, syntheticBox())
    scene.camera.fit(drawable.bounds)

    // --- render loop ---------------------------------------------------
    // Driven by the browser, never by a signal.
    let frame = 0
    const draw = () => {
      scene.render()
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)

    // --- sizing ---------------------------------------------------------
    // Device pixel ratio matters: a CAD viewport at half resolution looks
    // broken in a way users read as low quality rather than as a setting.
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      scene.resize(width, height, window.devicePixelRatio)
    })
    observer.observe(canvas)

    onCleanup(() => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      scene.dispose()
      device.dispose()
      props.session.scene = null
    })
  })

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

  const onPointerDown = (event: PointerEvent) => {
    const scene = props.session.scene
    if (!scene) return

    // Middle button or shift-drag pans; left button orbits. Matches
    // what every CAD tool does, so the muscle memory carries over.
    dragging = event.button === 1 || event.shiftKey ? "pan" : "orbit"
    lastX = event.clientX
    lastY = event.clientY
    event.currentTarget instanceof HTMLElement &&
      event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent) => {
    const scene = props.session.scene
    if (!scene || !dragging) return

    const deltaX = event.clientX - lastX
    const deltaY = event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY

    if (dragging === "orbit") {
      scene.camera.orbit(-deltaX * 0.008, deltaY * 0.008)
    } else {
      scene.camera.pan(deltaX, deltaY)
    }
  }

  const onPointerUp = (event: PointerEvent) => {
    dragging = null
    event.currentTarget instanceof HTMLElement &&
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    props.session.scene?.camera.dolly(event.deltaY)
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

/** What the active field will accept, or null when nothing is picking. */
function acceptedKinds(session: Session): readonly PickKind[] | null {
  const panel = session.panel()
  if (!panel) return null
  // TODO: read the active selector field from the panel session.
  return null
}

