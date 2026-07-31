// =====================================================================
// apps/web/render/render-loop.test.tsx
//
// The shared animation-frame loop, tested as a behaviour: mount something
// that subscribes, drive frames, and assert on what ran — never on the
// loop's internals. The loop must run only while something is subscribed,
// hand every tick the real elapsed time, and stop the moment the last
// subscriber unmounts.
// =====================================================================

import { cleanup, render } from "@solidjs/testing-library"
import { createSignal, Show } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RenderLoop, useRenderTick } from "./render-loop"

afterEach(() => {
  cleanup()
})

// Step the loop by hand: happy-dom drives requestAnimationFrame off timers,
// so awaiting a couple of frames lets any pending ticks run.
async function frames(count = 2) {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  }
}

describe("useRenderTick", () => {
  it("throws outside its provider, naming the one that is missing", () => {
    function Orphan() {
      useRenderTick(() => {})
      return null
    }
    expect(() => render(() => <Orphan />)).toThrow(
      "useRenderTick must be used inside <RenderLoop>",
    )
  })

  it("runs a subscribed tick every frame", async () => {
    const tick = vi.fn()
    function Ticker() {
      useRenderTick(tick)
      return null
    }
    render(() => (
      <RenderLoop>
        <Ticker />
      </RenderLoop>
    ))

    await frames(3)
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("hands each tick a finite, non-negative deltaSeconds", async () => {
    const deltas: number[] = []
    function Ticker() {
      useRenderTick((dt) => deltas.push(dt))
      return null
    }
    render(() => (
      <RenderLoop>
        <Ticker />
      </RenderLoop>
    ))

    await frames(3)
    expect(deltas.length).toBeGreaterThan(0)
    // First frame's delta is 0 (no previous timestamp); all are real times.
    expect(deltas[0]).toBe(0)
    for (const dt of deltas) {
      expect(Number.isFinite(dt)).toBe(true)
      expect(dt).toBeGreaterThanOrEqual(0)
    }
  })

  it("stops ticking a subscriber once it unmounts", async () => {
    const tick = vi.fn()
    const [mounted, setMounted] = createSignal(true)
    function Ticker() {
      useRenderTick(tick)
      return null
    }
    render(() => (
      <RenderLoop>
        <Show when={mounted()}>
          <Ticker />
        </Show>
      </RenderLoop>
    ))

    await frames(2)
    setMounted(false)
    await frames(1)
    const afterUnmount = tick.mock.calls.length
    await frames(3)
    // No further calls after it left.
    expect(tick.mock.calls.length).toBe(afterUnmount)
  })

  it("stops the rAF entirely when the last subscriber goes", async () => {
    const [mounted, setMounted] = createSignal(true)
    function Ticker() {
      useRenderTick(() => {})
      return null
    }
    render(() => (
      <RenderLoop>
        <Show when={mounted()}>
          <Ticker />
        </Show>
      </RenderLoop>
    ))

    await frames(2)
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame")
    setMounted(false)
    await frames(1)
    expect(cancel).toHaveBeenCalled()
    cancel.mockRestore()
  })

  it("runs several subscribers together, in one loop", async () => {
    const a = vi.fn()
    const b = vi.fn()
    function Two() {
      useRenderTick(a)
      useRenderTick(b)
      return null
    }
    render(() => (
      <RenderLoop>
        <Two />
      </RenderLoop>
    ))

    await frames(2)
    expect(a).toHaveBeenCalled()
    expect(b).toHaveBeenCalled()
  })
})
