// =====================================================================
// apps/web/widgets/floating.test.tsx
//
// The drag-and-remember behaviour shared by the view cube and the command
// panel. Tested through a mounted control the way a user drives it —
// press, move, release — rather than by poking the signal, because the
// parts most likely to break are the ones between those events: the
// click/drag threshold, the clamp, and what reaches localStorage.
// =====================================================================

import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createFloating, type Position } from "./floating"

const KEY = "linen.test.position"
const SIZE = { width: 100, height: 50 }

afterEach(() => {
  // Release before unmounting: a gesture tracks on WINDOW, so a test that
  // presses without releasing would leave its listener attached and it
  // would fire during the NEXT test's moves.
  release()
  cleanup()
  localStorage.clear()
})

beforeEach(() => {
  // happy-dom reports 1024x768; pin it so the clamp assertions below are
  // about the clamp rather than about the environment's defaults.
  window.innerWidth = 1024
  window.innerHeight = 768
})

/** Mounts a control and returns its handle plus a live position reader. */
function mountControl(initial: Position) {
  let read!: () => Position
  const result = render(() => {
    const floating = createFloating({
      storageKey: KEY,
      initial: () => initial,
      size: () => SIZE,
    })
    read = floating.position
    return (
      <div
        data-testid="handle"
        style={{ left: `${floating.position().x}px`, top: `${floating.position().y}px` }}
        {...floating.handleProps}
      />
    )
  })
  return { handle: result.getByTestId("handle"), position: () => read() }
}

const press = (node: Element, x: number, y: number): void => {
  node.dispatchEvent(
    new PointerEvent("pointerdown", { button: 0, clientX: x, clientY: y, bubbles: true }),
  )
}
// Move and release go to WINDOW: the gesture tracks there so a re-render
// mid-drag cannot take the listeners with it.
const move = (x: number, y: number): void => {
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y }))
}
const release = (): void => {
  window.dispatchEvent(new PointerEvent("pointerup", {}))
}

describe("createFloating", () => {
  it("starts at the caller's initial position when nothing is stored", () => {
    const { position } = mountControl({ x: 200, y: 120 })
    expect(position()).toEqual({ x: 200, y: 120 })
  })

  it("moves by the pointer delta, not to the pointer", () => {
    const { handle, position } = mountControl({ x: 200, y: 120 })
    // Pressed away from the control's own origin: a control that jumped
    // its top-left corner to the cursor would pass a to-the-pointer test
    // and still feel wrong under the hand.
    press(handle, 500, 400)
    move(530, 380)
    expect(position()).toEqual({ x: 230, y: 100 })
  })

  it("ignores movement below the drag threshold, so a click stays a click", () => {
    const { handle, position } = mountControl({ x: 200, y: 120 })
    press(handle, 500, 400)
    move(502, 401)
    expect(position()).toEqual({ x: 200, y: 120 })
  })

  it("ignores a non-left press, leaving the button to the control beneath", () => {
    const { handle, position } = mountControl({ x: 200, y: 120 })
    handle.dispatchEvent(
      new PointerEvent("pointerdown", { button: 2, clientX: 500, clientY: 400, bubbles: true }),
    )
    move(600, 500)
    expect(position()).toEqual({ x: 200, y: 120 })
  })

  it("clamps to the viewport, keeping the whole control reachable", () => {
    const { handle, position } = mountControl({ x: 200, y: 120 })
    press(handle, 500, 400)
    move(9000, 9000)
    expect(position()).toEqual({
      x: window.innerWidth - SIZE.width,
      y: window.innerHeight - SIZE.height,
    })
  })

  it("never clamps past the top-left, which would be unrecoverable", () => {
    const { handle, position } = mountControl({ x: 200, y: 120 })
    press(handle, 500, 400)
    move(-9000, -9000)
    expect(position()).toEqual({ x: 0, y: 0 })
  })

  it("persists only on a real drag", () => {
    const { handle } = mountControl({ x: 200, y: 120 })
    press(handle, 500, 400)
    move(501, 400)
    release()
    expect(localStorage.getItem(KEY)).toBeNull()

    press(handle, 500, 400)
    move(560, 460)
    release()
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ x: 260, y: 180 })
  })

  it("restores the stored position over the caller's initial", () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 42, y: 84 }))
    const { position } = mountControl({ x: 200, y: 120 })
    expect(position()).toEqual({ x: 42, y: 84 })
  })

  it("clamps a stored position that no longer fits, rather than trusting it", () => {
    // What a page-zoom or a smaller window leaves behind: coordinates that
    // were valid when written and are off-screen now.
    localStorage.setItem(KEY, JSON.stringify({ x: 5000, y: 5000 }))
    const { position } = mountControl({ x: 200, y: 120 })
    expect(position()).toEqual({
      x: window.innerWidth - SIZE.width,
      y: window.innerHeight - SIZE.height,
    })
  })

  it("falls back to the initial position when the store holds junk", () => {
    localStorage.setItem(KEY, "{not json")
    const { position } = mountControl({ x: 200, y: 120 })
    expect(position()).toEqual({ x: 200, y: 120 })
  })

  it("ignores a stored value missing a coordinate", () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 42 }))
    const { position } = mountControl({ x: 200, y: 120 })
    expect(position()).toEqual({ x: 200, y: 120 })
  })

  it("pulls the control back into view when the window shrinks", () => {
    const { position } = mountControl({ x: 900, y: 700 })
    window.innerWidth = 400
    window.innerHeight = 300
    window.dispatchEvent(new Event("resize"))
    expect(position()).toEqual({ x: 300, y: 250 })
  })
})
