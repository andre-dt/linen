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

import {
  onMount, onCleanup, createSignal, Show, createEffect, For,
} from "solid-js"
import {
  GestureDetector,
  type DragGesture, type HoverGesture, type ClickGesture,
} from "./gestures"
import {
  createBackend, createScene, PLANE_EXTENT,
  checkViewportCapabilities, CAPABILITY_MESSAGE,
} from "@linen/viewer"
import type {
  Backend, Scene, PlaneHit, DatumPlaneId, SketchFrame, SketchCurve, SketchPoint,
  CapabilityReason,
} from "@linen/viewer"

/** How much of the viewport height the origin planes occupy on open. */
const PLANE_COVERAGE = 0.6

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

  // --- drawing ---------------------------------------------------------
  /** The plane being sketched on. Non-null puts the viewport in drawing
   *  mode: clicks become points instead of camera moves. */
  readonly sketchFrame?: SketchFrame | null
  /** Curves already drawn, rendered solid. */
  readonly sketchCurves?: readonly SketchCurve[]
  /** The rubber band, recomputed by the parent from the live cursor. */
  readonly sketchPreview?: SketchCurve | null
  /** A point was clicked on the sketch plane, already snapped. */
  readonly onSketchClick?: (point: SketchPoint) => void
  /** The cursor moved over the sketch plane. Drives the rubber band. */
  readonly onSketchMove?: (point: SketchPoint | null) => void
  /** A double click: ends an open-ended tool such as a spline. */
  readonly onSketchFinish?: () => void
}

export function Viewport(props: ViewportProps) {
  let canvas!: HTMLCanvasElement
  const [failure, setFailure] = createSignal<string | null>(null)
  const [backend, setBackend] = createSignal<"webgpu" | "webgl2" | null>(null)
  // The capabilities the viewport hard-requires and cannot fake: a 3D
  // backend and the HTML-in-Canvas API the chrome is drawn with. Checked
  // once up front. When something is missing this stays populated and the
  // canvas is replaced by a message naming EACH missing piece — the rest
  // of the app is unaffected, only the designer canvas is.
  const [missing, setMissing] = createSignal<readonly CapabilityReason[]>([])
  // Held outside the reactive graph on purpose: the render loop reads it
  // every frame, and a signal would schedule DOM work sixty times a
  // second for state no DOM node displays.
  let scene: Scene | null = null

  onMount(async () => {
    // The capability gate comes FIRST — before touching a real backend.
    // If the browser is missing a requirement there is nothing to draw
    // and no point allocating a context; the message stands in for the
    // canvas and mounting stops here.
    const capability = checkViewportCapabilities()
    if (!capability.ok) {
      setMissing(capability.missing)
      return
    }

    let device: Backend
    try {
      // WebGL2 explicitly, NOT the default preference.
      //
      // createBackend prefers WebGPU, but createScene only implements
      // WebGL2 — so on a machine that HAS a WebGPU adapter the two
      // disagree and the viewport dies with "the WebGPU renderer is not
      // implemented yet". Asking for what we can actually draw with is
      // the fix; flip this back the moment the WebGPU path lands.
      device = await createBackend(canvas, "webgl2")
      setBackend(device.kind)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "no usable graphics backend")
      return
    }

    // Inside the guard: createScene throws for an unimplemented backend
    // and for any shader that fails to compile. Outside it, that throw
    // escaped into an async onMount and vanished — leaving a blank canvas
    // and no message, which is the hardest possible failure to diagnose.
    let active: Scene
    try {
      active = createScene(device)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "could not create the scene")
      device.dispose()
      return
    }
    scene = active
    props.onScene?.(active)

    // Frame the datum planes, so an empty part opens looking at the
    // things it can actually be started from rather than at nothing.
    //
    // Orient BEFORE fitting: fit derives the distance from the bounds as
    // seen from the current angle, so framing first and turning after
    // would frame the wrong silhouette.
    active.camera.viewFrom("isometric")
    active.camera.fit(
      {
        minimum: [-PLANE_EXTENT, -PLANE_EXTENT, -PLANE_EXTENT],
        maximum: [PLANE_EXTENT, PLANE_EXTENT, PLANE_EXTENT],
      },
      // fit() measures the bounding DIAGONAL, which is the right measure
      // for a solid. The origin planes are a hollow cross: their
      // silhouette is 1/√2 of that diagonal, so asking for 60% of the
      // box yields 42% of the screen. Dividing by √2 asks for the box
      // fraction whose CROSS lands at the 60% actually wanted.
      PLANE_COVERAGE * Math.SQRT2,
    )

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
    // The origin planes stay visible: they are the empty scene itself,
    // not a transient affordance. `pickingPlane` decides whether clicks
    // land on them, not whether they are drawn.
    scene.planes.selected = (props.selectedPlane as DatumPlaneId | null) ?? null
    // Nothing under the cursor until the pointer moves again: a stale
    // hover would stay lit after the planes are re-shown.
    if (!props.pickingPlane) scene.planes.hovered = null
  })

  // The sketch, likewise: signals publish what to draw, the scene draws
  // it. The cursor is NOT in here — it changes on every mouse move and
  // is written directly in the pointer handler, because routing sixty
  // updates a second through the reactive graph is the one thing this
  // boundary exists to prevent.
  createEffect(() => {
    if (!scene) return
    scene.sketch.frame = props.sketchFrame ?? null
    scene.sketch.curves = props.sketchCurves ?? []
    scene.sketch.pending = props.sketchPreview ?? null
    if (!props.sketchFrame) {
      scene.sketch.cursor = null
      scene.sketch.snappedTo = null
    }
  })

  /** True while the viewport is a drawing surface rather than a camera. */
  const drawing = (): boolean => props.sketchFrame != null

  // --- gestures ---------------------------------------------------------
  // The viewport receives INTENT, never button numbers: GestureDetector
  // resolves those through the binding supplied by GestureProvider. What
  // is left here is only what a viewport should know — how to move a
  // camera and what a click means to the active step.

  const onDrag = (gesture: DragGesture): void => {
    if (!scene) return
    if (gesture.kind === "orbit") {
      scene.camera.orbit(-gesture.deltaX * 0.008, gesture.deltaY * 0.008)
    } else {
      scene.camera.pan(gesture.deltaX, gesture.deltaY)
    }
  }

  const onHover = (gesture: HoverGesture): void => {
    if (!scene) return

    // Drawing: resolve the cursor onto the sketch plane and publish it.
    // Written straight to the scene so the crosshair tracks at frame
    // rate, and handed up so the rubber band can follow.
    if (drawing()) {
      const found = scene.sketch.locate(gesture.x, gesture.y)
      scene.sketch.cursor = found?.point ?? null
      scene.sketch.snappedTo = found?.kind ?? null
      props.onSketchMove?.(found?.point ?? null)
      return
    }

    // Otherwise light the datum plane under the cursor, but only while a
    // step is actually asking for one.
    if (props.pickingPlane) {
      scene.planes.hovered = scene.planes.pick(gesture.x, gesture.y)?.plane.id ?? null
    }
  }

  const onClick = (gesture: ClickGesture): void => {
    if (!scene) return

    if (drawing()) {
      const found = scene.sketch.locate(gesture.x, gesture.y)
      if (found) props.onSketchClick?.(found.point)
      return
    }

    if (!props.pickingPlane) return
    const hit = scene.planes.pick(gesture.x, gesture.y)
    if (hit) props.onPickPlane?.(hit)
  }

  // The cursor left the canvas: drop the crosshair and the rubber band,
  // or they stay frozen wherever the pointer last was.
  const onLeave = (): void => {
    if (!scene) return
    scene.sketch.cursor = null
    scene.sketch.snappedTo = null
    scene.planes.hovered = null
    if (drawing()) props.onSketchMove?.(null)
  }

  return (
    <Show
      when={missing().length === 0}
      fallback={
        // The designer canvas cannot render here. The block sits centred
        // in the area the canvas would have filled, but its TEXT is left
        // aligned — a wall of centred prose is hard to read, and each
        // reason is its own paragraph so a browser missing more than one
        // capability learns about all of them at once.
        <div class="viewport-unsupported">
          <div class="viewport-unsupported-body">
            <p class="viewport-unsupported-title">
              The 3D designer can't run in this browser.
            </p>
            <For each={missing()}>
              {(reason) => <p>{CAPABILITY_MESSAGE[reason]}</p>}
            </For>
          </div>
        </div>
      }
    >
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
      {/* A positioned wrapper: the labels are absolutely placed against
          it, and the canvas fills it. The canvas cannot be their offset
          parent — it has no children. */}
      <div class="viewport-stack">
        <GestureDetector
          onDrag={onDrag}
          onHover={onHover}
          onClick={onClick}
          onLeave={onLeave}
          onDoubleClick={() => drawing() && props.onSketchFinish?.()}
          onZoom={(delta) => scene?.camera.dolly(delta)}
        >
          {(gestures) => (
            <canvas
              ref={canvas}
              class="viewport"
              data-backend={backend()}
              // A crosshair says "this surface takes clicks" before the
              // user tries one — the signal every drawing tool gives.
              data-drawing={drawing()}
              {...gestures}
            />
          )}
        </GestureDetector>

      </div>
    </Show>
    </Show>
  )
}
