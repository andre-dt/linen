// =====================================================================
// apps/web/widgets/plane-picker.test.tsx
//
// The plane field. What is worth pinning is that it takes NO keyboard:
// the value arrives from a canvas click, so the field shows text and
// nothing else — no tab stop, no caret, no focus. It reads as a label
// that happens to hold a value, and the keyboard walks past it to the
// controls that actually take one.
// =====================================================================

import { cleanup, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"

import { PlanePicker } from "./plane-picker"
import { ToastProvider } from "../toast"

afterEach(() => cleanup())

const field = {
  kind: "plane", name: "plane", label: "Plane",
  allowFace: true, allowOffset: true, optional: false, help: null,
} as never

const mount = (value: unknown) =>
  render(() => (
    <ToastProvider>
      <PlanePicker field={field} value={value} error={null} />
    </ToastProvider>
  ))

const control = (container: HTMLElement): HTMLElement =>
  container.querySelector<HTMLElement>(".field-value")!

describe("PlanePicker", () => {
  it("shows text, not an input", () => {
    const shown = control(mount(undefined).container)
    // An input — even readonly — sits in the tab order, takes a caret
    // and answers the keyboard, all of which promise an interaction
    // this field does not have.
    expect(shown.tagName).toBe("SPAN")
    expect(mount(undefined).container.querySelector("input")).toBe(null)
  })

  it("takes no focus on mount", () => {
    mount(undefined)
    // Nothing to focus, and nothing focused. A field that grabs focus
    // on appearing moves the keyboard somewhere the user did not ask
    // for — and this panel makes fields appear on every step it walks.
    expect(document.activeElement).toBe(document.body)
  })

  it("prompts when empty", () => {
    expect(control(mount(undefined).container).textContent).toBe("Select a plane or face")
  })

  it("names the chosen plane by its view", () => {
    const shown = control(mount({ kind: "datum", plane: "front", axes: "XZ", offset: 0 }).container)
    expect(shown.textContent).toBe("Front plane")
  })

  it("falls back to the stored id for a plane this build does not know", () => {
    // Documents outlive builds: a plane named by an older version must
    // show what is stored rather than being mislabelled.
    const shown = control(mount({ kind: "datum", plane: "isometric", axes: "XY", offset: 0 }).container)
    expect(shown.textContent).toBe("isometric")
  })

  it("names a face reference", () => {
    const shown = control(mount({ kind: "face", face: "f7/side[3]", offset: 0 }).container)
    expect(shown.textContent).toBe("Face f7/side[3]")
  })

  it("follows the model when the value changes", () => {
    // The text is rendered from the value, so it tracks the panel with
    // no binding to get wrong. The input this replaced needed the DOM
    // property written by an effect — the `value` ATTRIBUTE is only the
    // element's default, and a field bound that way stopped tracking
    // the moment anything wrote into it.
    const [value, setValue] = createSignal<unknown>({
      kind: "datum", plane: "front", axes: "XZ", offset: 0,
    })
    const { container } = render(() => (
      <ToastProvider>
        <PlanePicker field={field} value={value()} error={null} />
      </ToastProvider>
    ))
    expect(control(container).textContent).toBe("Front plane")
    setValue({ kind: "datum", plane: "top", axes: "XY", offset: 0 })
    expect(control(container).textContent).toBe("Top plane")
  })
})
