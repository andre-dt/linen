// =====================================================================
// apps/web/render/initial-framing.tsx — how the view opens.
//
// A behaviour, not a provider: mounted once under the camera, it frames
// the datum planes the first time the camera comes alive, so an empty part
// opens looking at the things it can be started from rather than at
// nothing. Pull it out of the tree and the view opens wherever the camera
// defaults to — nothing else changes.
//
// It waits for the camera because the scene is created in an async mount:
// the effect re-runs when useCamera() flips from null to live, frames
// once, and a guard stops it ever reframing on a later tick.
// =====================================================================

import { createEffect } from "solid-js"
import { PLANE_EXTENT } from "@linen/viewer"
import { useCamera } from "./camera-provider"

/** How much of the viewport height the origin planes occupy on open. */
const PLANE_COVERAGE = 0.6

export function InitialFraming() {
  const camera = useCamera()
  let framed = false

  createEffect(() => {
    const view = camera()
    if (!view || framed) return
    framed = true

    // Orient BEFORE fitting: fit derives the distance from the bounds as
    // seen from the current angle, so framing first and turning after would
    // frame the wrong silhouette.
    view.viewFrom("isometric")
    view.fit(
      {
        minimum: [-PLANE_EXTENT, -PLANE_EXTENT, -PLANE_EXTENT],
        maximum: [PLANE_EXTENT, PLANE_EXTENT, PLANE_EXTENT],
      },
      // fit() measures the bounding DIAGONAL; the origin planes are a
      // hollow cross whose silhouette is 1/√2 of it, so divide by √2 to
      // land the cross at the 60% actually wanted.
      PLANE_COVERAGE * Math.SQRT2,
    )
  })

  return null
}
