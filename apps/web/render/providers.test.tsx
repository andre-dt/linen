// =====================================================================
// apps/web/render/providers.test.tsx
//
// The context CONTRACT the 3D-world providers share: a consumer used
// outside its provider is a wiring mistake, and the use-hook throws saying
// exactly which provider is missing — rather than handing back a silent
// default nobody chose. Tested by mounting an orphan consumer and asserting
// the throw; no GPU or scene needed.
//
// CameraProvider's happy path (re-exposing the live camera) needs a real
// backend, so it is not unit-tested here — only its contract is.
// =====================================================================

import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"

import { RenderLoop } from "./render-loop"
import { RenderingCanvas, useRendering } from "./rendering-canvas"
import { CameraProvider, useCamera } from "./camera-provider"
import { useGestureBinding } from "../gestures"

afterEach(() => {
  cleanup()
})

describe("provider contracts — throw outside the provider", () => {
  it("useRendering names <RenderingCanvas>", () => {
    function Orphan() {
      useRendering()
      return null
    }
    expect(() => render(() => <Orphan />)).toThrow(
      "useRendering must be used inside <RenderingCanvas>",
    )
  })

  it("useCamera names <CameraProvider>", () => {
    function Orphan() {
      useCamera()
      return null
    }
    expect(() => render(() => <Orphan />)).toThrow(
      "useCamera must be used inside <CameraProvider>",
    )
  })

  it("useGestureBinding names <GestureProvider>", () => {
    function Orphan() {
      useGestureBinding()
      return null
    }
    expect(() => render(() => <Orphan />)).toThrow(
      "useGestureBinding must be used inside <GestureProvider>",
    )
  })
})

describe("the provider tree wires up", () => {
  it("gives a live camera accessor that reads null until a scene exists", () => {
    // Mounted under RenderLoop + RenderingCanvas with NO <SceneCanvas>, so
    // no backend is ever built — the accessor exists and safely reads null
    // rather than throwing. This is the state every consumer must tolerate
    // (the scene starts async), and the wiring that lets the cube/gestures
    // no-op on null instead of crashing before the first frame.
    let read: (() => unknown) | undefined
    function Probe() {
      const camera = useCamera()
      read = camera
      return null
    }
    render(() => (
      <RenderLoop>
        <RenderingCanvas>
          <CameraProvider>
            <Probe />
          </CameraProvider>
        </RenderingCanvas>
      </RenderLoop>
    ))

    expect(read).toBeDefined()
    expect(read!()).toBeNull()
  })
})
