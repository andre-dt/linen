// =====================================================================
// apps/web/render/rendering-canvas.tsx — the drawing surface + the scene.
//
// Owns the imperative half of the 3D world: the graphics backend, the
// model Scene (which owns the camera), device-pixel sizing, and disposal.
// It provides the Scene through context so behaviours below it — the
// camera, the gestures, the cube — reach it with useRendering() instead of
// a scene handle prop-drilled down from the screen.
//
// PROVIDER vs CANVAS ARE SEPARATE, on purpose. <RenderingCanvas> is the
// provider: it wraps a whole HUD subtree, so both the viewport interaction
// AND the floating cube (far apart in the markup) share one camera. The
// actual <canvas> is rendered by <SceneCanvas>, a leaf placed in the
// canvas slot — it hands its element back to the provider, which then
// builds the backend on it. A capability/backend failure blanks only the
// canvas slot, never the surrounding panels.
//
// It draws by SUBSCRIBING scene.render() to the shared <RenderLoop>, so it
// opens no requestAnimationFrame of its own. Disposal order matters: the
// render tick is unsubscribed BEFORE the renderer is disposed, so no frame
// ever calls render() on a released scene.
// =====================================================================

import {
  createContext, useContext, createSignal, createEffect, onCleanup,
  Show, For, type Accessor, type JSX,
} from "solid-js"
import {
  createConfiguredRenderer,
  checkViewportCapabilities, CAPABILITY_MESSAGE,
} from "@linen/viewer"
import type {
  Renderer, Scene, CapabilityReason,
} from "@linen/viewer"
import { useRenderLoop } from "./render-loop"

interface RenderingValue {
  /** The live model scene, or null until it exists (and while the browser
   *  cannot draw). Read imperatively by ticks and handlers — never a signal
   *  in JSX, so an unrelated redraw never touches the renderer. */
  readonly scene: () => Scene | null
  /** True once the scene is live and drawing. */
  readonly ready: Accessor<boolean>
  /** Which backend was chosen, for a data attribute / diagnostics. */
  readonly backend: Accessor<"webgpu" | "webgl2" | null>
  // --- used by <SceneCanvas>; not for general consumers -----------------
  /** The canvas hands its element here; the provider builds the backend on
   *  it. Called once, when SceneCanvas mounts. */
  readonly attach: (canvas: HTMLCanvasElement) => void
  /** Capability gaps, so SceneCanvas can render the reason in its slot. */
  readonly missing: Accessor<readonly CapabilityReason[]>
  /** A backend/scene-creation failure message, likewise. */
  readonly failure: Accessor<string | null>
}

const RenderingContext = createContext<RenderingValue>()

export const useRendering = (): RenderingValue => {
  const value = useContext(RenderingContext)
  if (!value) {
    throw new Error("useRendering must be used inside <RenderingCanvas>")
  }
  return value
}

export function RenderingCanvas(props: { children: JSX.Element }) {
  const loop = useRenderLoop()

  const [failure, setFailure] = createSignal<string | null>(null)
  const [backend, setBackend] = createSignal<"webgpu" | "webgl2" | null>(null)
  const [missing, setMissing] = createSignal<readonly CapabilityReason[]>([])
  const [ready, setReady] = createSignal(false)
  const [canvas, setCanvas] = createSignal<HTMLCanvasElement | null>(null)
  // Outside the reactive graph: the render tick reads it every frame, and a
  // signal would schedule DOM work sixty times a second for state no DOM
  // node displays.
  let scene: Scene | null = null

  // Build the backend once the canvas has been handed over. An effect, not
  // onMount: SceneCanvas mounts as a child, so its element arrives after
  // this component's own mount.
  createEffect(() => {
    const element = canvas()
    if (!element) return

    let renderer: Renderer | null = null
    let unsubscribe: (() => void) | null = null
    let observer: ResizeObserver | null = null
    let disposed = false

    void (async () => {
      // Capability gate FIRST — before touching a real backend. If the
      // browser is missing a requirement there is nothing to draw; the
      // message stands in for the canvas.
      const capability = checkViewportCapabilities()
      if (!capability.ok) {
        setMissing(capability.missing)
        return
      }

      try {
        renderer = await createConfiguredRenderer(element)
        setBackend(renderer.kind)
      } catch (error) {
        setFailure(error instanceof Error ? error.message : "no usable graphics backend")
        return
      }

      let active: Scene
      try {
        active = renderer.createScene()
      } catch (error) {
        setFailure(error instanceof Error ? error.message : "could not create the scene")
        renderer.dispose()
        renderer = null
        return
      }
      // The mount could have been torn down while awaiting the backend.
      if (disposed) { renderer.dispose(); renderer = null; return }

      scene = active
      setReady(true)

      // The opening framing (viewFrom + fit) is a behaviour, <InitialFraming>,
      // mounted under the camera — not done here. This module owns the
      // resource; how the view opens is a separate concern.

      // Draw through the SHARED loop instead of a private rAF. scene.render()
      // internally advances the camera's view transitions by real time.
      unsubscribe = loop.subscribe(() => active.render())

      observer = new ResizeObserver(([entry]) => {
        if (!entry) return
        const { width, height } = entry.contentRect
        active.resize(width, height, window.devicePixelRatio)
      })
      observer.observe(element)
    })()

    onCleanup(() => {
      disposed = true
      // Unsubscribe BEFORE dispose: a tick must never reach a released scene.
      unsubscribe?.()
      observer?.disconnect()
      renderer?.dispose() // owns scene + backend + engine
      scene = null
      setReady(false)
    })
  })

  const value: RenderingValue = {
    scene: () => scene,
    ready,
    backend,
    attach: setCanvas,
    missing,
    failure,
  }

  return (
    <RenderingContext.Provider value={value}>
      {props.children}
    </RenderingContext.Provider>
  )
}

/**
 * Renders the <canvas> the scene draws into, plus the capability/failure
 * message that stands in for it when the browser cannot draw. Place it in
 * the canvas slot; it registers its element with the surrounding
 * <RenderingCanvas>, which builds the backend on it. Failures blank only
 * this slot, leaving the rest of the HUD alone.
 */
export function SceneCanvas() {
  const rendering = useRendering()

  return (
    <Show
      when={rendering.missing().length === 0}
      fallback={
        <div class="viewport-unsupported">
          <div class="viewport-unsupported-body">
            <p class="viewport-unsupported-title">
              The 3D designer can't run in this browser.
            </p>
            <For each={rendering.missing()}>
              {(reason) => <p>{CAPABILITY_MESSAGE[reason]}</p>}
            </For>
          </div>
        </div>
      }
    >
      <Show
        when={!rendering.failure()}
        fallback={
          <div class="viewport-failure">
            <p>{rendering.failure()}</p>
            <p class="viewport-failure-hint">Linen needs WebGPU or WebGL2.</p>
          </div>
        }
      >
        <canvas
          ref={(node) => rendering.attach(node)}
          class="viewport"
          data-backend={rendering.backend()}
        />
      </Show>
    </Show>
  )
}
