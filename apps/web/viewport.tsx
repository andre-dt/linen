// =====================================================================
// apps/web/viewport.tsx — the interaction surface.
//
// Where the reactive world meets the imperative one. It no longer owns the
// canvas, the backend, or the scene — <RenderingCanvas> does, and this
// reads them from context (useRendering / useCamera). What is left here is
// interaction: turning pointer gestures into camera moves, publishing which
// plane/sketch state the scene should draw, and resolving clicks onto a
// plane or sketch.
//
// The gestures attach to a transparent OVERLAY that covers the canvas
// rather than the canvas element itself: the canvas is rendered by
// RenderingCanvas (which draws into it), and a coincident overlay carries
// the pointer handling without either layer reaching into the other.
//
// The boundary is still deliberate. A signal driving buffer uploads would
// re-run on every unrelated state change; here signals only PUBLISH intent
// (which plane is lit, what curves to draw), never a redraw.
// =====================================================================

import { createEffect } from "solid-js"
import {
  GestureDetector,
  type DragGesture, type HoverGesture, type ClickGesture,
} from "./gestures"
import { useRendering } from "./render/rendering-canvas"
import { useCamera } from "./render/camera-provider"
import type {
  PlaneHit, DatumPlaneId, SketchFrame, SketchCurve, SketchPoint,
} from "@linen/viewer"

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
  const rendering = useRendering()
  const camera = useCamera()

  // The ONE place signals touch the scene: publishing intent. Which plane
  // is lit is panel state, so it crosses the boundary — but as two scalar
  // writes per change, not as a redraw.
  createEffect(() => {
    const scene = rendering.scene()
    if (!scene) return
    // The origin planes stay visible: they are the empty scene itself, not
    // a transient affordance. `pickingPlane` decides whether clicks land on
    // them, not whether they are drawn.
    scene.planes.selected = (props.selectedPlane as DatumPlaneId | null) ?? null
    // Nothing under the cursor until the pointer moves again: a stale hover
    // would stay lit after the planes are re-shown.
    if (!props.pickingPlane) scene.planes.hovered = null
  })

  // The sketch, likewise: signals publish what to draw, the scene draws it.
  // The cursor is NOT here — it changes on every mouse move and is written
  // directly in the pointer handler, because routing sixty updates a second
  // through the reactive graph is the one thing this boundary prevents.
  createEffect(() => {
    const scene = rendering.scene()
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
  // Intent, never button numbers: GestureDetector resolves those through
  // the binding from GestureProvider. What is left is what a viewport knows
  // — how to move a camera and what a click means to the active step.

  const onDrag = (gesture: DragGesture): void => {
    const view = camera()
    if (!view) return
    if (gesture.kind === "orbit") {
      view.orbit(-gesture.deltaX * 0.008, gesture.deltaY * 0.008)
    } else {
      view.pan(gesture.deltaX, gesture.deltaY)
    }
  }

  const onHover = (gesture: HoverGesture): void => {
    const scene = rendering.scene()
    if (!scene) return

    // Drawing: resolve the cursor onto the sketch plane and publish it.
    // Written straight to the scene so the crosshair tracks at frame rate,
    // and handed up so the rubber band can follow.
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
    const scene = rendering.scene()
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

  // The cursor left the surface: drop the crosshair and rubber band, or
  // they stay frozen wherever the pointer last was.
  const onLeave = (): void => {
    const scene = rendering.scene()
    if (!scene) return
    scene.sketch.cursor = null
    scene.sketch.snappedTo = null
    scene.planes.hovered = null
    if (drawing()) props.onSketchMove?.(null)
  }

  return (
    <GestureDetector
      onDrag={onDrag}
      onHover={onHover}
      onClick={onClick}
      onLeave={onLeave}
      onDoubleClick={() => drawing() && props.onSketchFinish?.()}
      onZoom={(delta, focal) => camera()?.dolly(delta, focal)}
    >
      {(gestures) => (
        // A transparent overlay coincident with the canvas. It carries the
        // pointer handling; the canvas (rendered by RenderingCanvas) carries
        // the pixels. A crosshair cursor says "this surface takes clicks"
        // before the user tries one — the signal every drawing tool gives.
        <div
          class="viewport-interaction"
          data-drawing={drawing()}
          style={{
            position: "absolute",
            inset: "0",
          }}
          {...gestures}
        />
      )}
    </GestureDetector>
  )
}
