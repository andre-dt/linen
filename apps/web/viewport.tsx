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
import { createBackend, loadMeshCodec } from "@linen/viewer"
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

    // The codec is WASM: mesh decode, picking and hierarchy building.
    // It is not a second kernel — no geometry is evaluated here.
    await loadMeshCodec()

    // Kept off the reactive graph on purpose.
    const scene = createScene(device)
    props.session.scene = scene

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

  const onPointerMove = (event: PointerEvent) => {
    const scene = props.session.scene
    if (!scene) return
    const accepts = acceptedKinds(props.session)
    if (!accepts) return
    // Hover highlighting is imperative: it changes every mouse move and
    // has no business scheduling DOM work.
    scene.highlight.hovered = null
  }

  const onPointerDown = (event: PointerEvent) => {
    const scene = props.session.scene
    if (!scene) return
    const accepts = acceptedKinds(props.session)
    if (!accepts) return
    // TODO: pick() and hand the result to the panel session.
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
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
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

declare function createScene(backend: Backend): Scene
