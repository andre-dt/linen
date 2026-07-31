// =====================================================================
// apps/web/render/camera-provider.tsx — the camera, as context.
//
// The Scene owns the camera; this re-exposes it so behaviours reach it
// with useCamera() instead of a scene handle threaded down from the
// screen. It is thin on purpose — the camera lives in the scene — but it
// is the seam every consumer binds to, so the cube and the gestures never
// touch the Scene directly to move the view.
//
// useCamera() returns an ACCESSOR: the camera is null until the scene is
// live (and while the browser cannot draw). Callers read camera() inside a
// tick or handler and no-op on null — the same discipline the old code
// kept with its `scene` variable, now behind one name.
// =====================================================================

import {
  createContext, useContext, type Accessor, type JSX,
} from "solid-js"
import type { Camera } from "@linen/viewer"
import { useRendering } from "./rendering-canvas"

const CameraContext = createContext<Accessor<Camera | null>>()

/** The live camera, or null until the scene exists. Read inside a tick or
 *  a pointer handler; never a signal in JSX driving a per-frame redraw. */
export const useCamera = (): Accessor<Camera | null> => {
  const value = useContext(CameraContext)
  if (!value) {
    throw new Error("useCamera must be used inside <CameraProvider>")
  }
  return value
}

export function CameraProvider(props: { children: JSX.Element }) {
  const rendering = useRendering()
  // The camera is a property of the scene, so this accessor tracks the
  // scene's own null→live transition with no extra state.
  const camera: Accessor<Camera | null> = () => rendering.scene()?.camera ?? null

  return (
    <CameraContext.Provider value={camera}>
      {props.children}
    </CameraContext.Provider>
  )
}
