// =====================================================================
// apps/web/toast.test.tsx
//
// The toast contract, driven the way a caller and a user drive it: raise
// a message through the hook, then click it or let it expire. The rules
// worth pinning are the ones a reader would otherwise have to infer —
// what expires, what does not, and what an action does.
// =====================================================================

import { cleanup, render, fireEvent } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ToastProvider, useToast, type ToastOptions } from "./toast"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Mounts the provider and hands back the api the hook would give a
 *  component deep inside it. */
function mountToasts() {
  let api!: ReturnType<typeof useToast>
  function Probe() {
    api = useToast()
    return null
  }
  const result = render(() => (
    <ToastProvider>
      <Probe />
    </ToastProvider>
  ))
  return {
    show: (text: string, options?: ToastOptions) => api.show(text, options),
    dismiss: (id: number) => api.dismiss(id),
    toasts: () => api.toasts(),
    container: result.container,
    // The toast elements themselves, in stack order.
    rendered: () => Array.from(result.container.querySelectorAll(".toast")),
  }
}

describe("useToast", () => {
  it("throws outside its provider, naming the one that is missing", () => {
    function Orphan() {
      useToast()
      return null
    }
    expect(() => render(() => <Orphan />)).toThrow(
      "useToast must be used inside <ToastProvider>",
    )
  })
})

describe("ToastProvider", () => {
  it("shows a message and renders its text", () => {
    const { show, rendered } = mountToasts()
    show("Saved")
    expect(rendered()).toHaveLength(1)
    expect(rendered()[0]!.textContent).toContain("Saved")
  })

  it("stacks messages with the newest last", () => {
    const { show, rendered } = mountToasts()
    show("first")
    show("second")
    expect(rendered().map((node) => node.textContent)).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
    ])
  })

  it("renders nothing at all when empty, so it cannot swallow clicks", () => {
    const { container } = mountToasts()
    expect(container.querySelector(".toast-stack")).toBeNull()
  })

  it("expires a transient toast after its duration", () => {
    vi.useFakeTimers()
    const { show, toasts } = mountToasts()
    show("transient")
    expect(toasts()).toHaveLength(1)
    vi.advanceTimersByTime(4999)
    expect(toasts()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(toasts()).toHaveLength(0)
  })

  it("honours a custom duration", () => {
    vi.useFakeTimers()
    const { show, toasts } = mountToasts()
    show("quick", { durationMilliseconds: 100 })
    vi.advanceTimersByTime(100)
    expect(toasts()).toHaveLength(0)
  })

  it("never expires a persistent toast", () => {
    vi.useFakeTimers()
    const { show, toasts } = mountToasts()
    show("stay", { persistent: true })
    vi.advanceTimersByTime(60_000)
    expect(toasts()).toHaveLength(1)
  })

  it("treats a toast carrying an action as persistent", () => {
    vi.useFakeTimers()
    const { show, toasts } = mountToasts()
    show("Failed", { action: { label: "Retry", run: () => {} } })
    vi.advanceTimersByTime(60_000)
    // An offer that expires while being read is worse than one more click.
    expect(toasts()).toHaveLength(1)
  })

  it("dismisses any toast on click, persistent or not", () => {
    const { show, toasts, rendered } = mountToasts()
    show("stay", { persistent: true })
    fireEvent.click(rendered()[0]!)
    expect(toasts()).toHaveLength(0)
  })

  it("runs an action on click and then dismisses", () => {
    const run = vi.fn()
    const { show, toasts, rendered } = mountToasts()
    show("Failed", { action: { label: "Retry", run } })
    fireEvent.click(rendered()[0]!)
    expect(run).toHaveBeenCalledOnce()
    expect(toasts()).toHaveLength(0)
  })

  // Returning an id is the whole reason show() is not void: a caller that
  // owns a long-running thing dismisses its own message when it ends.
  it("dismisses by id, leaving the other toasts alone", () => {
    const { show, dismiss, toasts } = mountToasts()
    const first = show("first", { persistent: true })
    show("second", { persistent: true })
    dismiss(first)
    expect(toasts().map((toast) => toast.text)).toEqual(["second"])
  })

  it("defaults to the info level and carries the level to the DOM", () => {
    const { show, rendered } = mountToasts()
    show("plain")
    show("bad", { level: "error" })
    expect(rendered()[0]!.getAttribute("data-level")).toBe("info")
    expect(rendered()[1]!.getAttribute("data-level")).toBe("error")
  })

  it("does not fire a pending timer after the provider unmounts", () => {
    vi.useFakeTimers()
    const { show } = mountToasts()
    show("transient")
    cleanup()
    // A timer surviving into a disposed reactive graph is the classic
    // provider leak; advancing past the lifetime must be silent.
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
  })
})
