// =====================================================================
// apps/web/widgets/plane-picker.test.tsx
//
// The plane field. What is worth pinning is the part that is easy to
// regress into a <span>: it is a real INPUT — focusable, readonly,
// carrying a caret — because the value arrives from a canvas click but
// the field still has to behave like the ones beside it.
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

const control = (container: HTMLElement): HTMLInputElement =>
  container.querySelector<HTMLInputElement>(".field-control")!

describe("PlanePicker", () => {
  it("renders a readonly input, not a label", () => {
    const input = control(mount(undefined).container)
    // A span would be dead to the keyboard and read as a different kind
    // of thing from the fields around it.
    expect(input.tagName).toBe("INPUT")
    // readonly, NOT disabled: disabled would drop it from the tab order
    // and grey it out, when the field is perfectly editable — just not
    // by typing.
    expect(input.readOnly).toBe(true)
    expect(input.disabled).toBe(false)
  })

  it("takes focus on mount while still empty, so the caret is already blinking", () => {
    const input = control(mount(undefined).container)
    expect(document.activeElement).toBe(input)
    expect(input.placeholder).toBe("Select a plane or face")
  })

  it("does not steal focus when the plane is already chosen", () => {
    // A step revisited to change something else must not yank focus back
    // to a field that is already answered.
    const input = control(mount({ kind: "datum", plane: "front", axes: "XZ", offset: 0 }).container)
    expect(document.activeElement).not.toBe(input)
  })

  it("names the chosen plane by its view", () => {
    const input = control(mount({ kind: "datum", plane: "front", axes: "XZ", offset: 0 }).container)
    expect(input.value).toBe("Front plane")
  })

  it("falls back to the stored id for a plane this build does not know", () => {
    // Documents outlive builds: a plane named by an older version must
    // show what is stored rather than being mislabelled.
    const input = control(mount({ kind: "datum", plane: "isometric", axes: "XY", offset: 0 }).container)
    expect(input.value).toBe("isometric")
  })

  it("names a face reference", () => {
    const input = control(mount({ kind: "face", face: "f7/side[3]", offset: 0 }).container)
    expect(input.value).toBe("Face f7/side[3]")
  })

  it("follows the model when the value changes", () => {
    // Bound as `prop:value`, not the `value` ATTRIBUTE. The attribute is
    // only the element's DEFAULT — set once, after which the DOM property
    // is the truth — so a field bound that way stops tracking the panel
    // the moment anything writes into it.
    const [value, setValue] = createSignal<unknown>({
      kind: "datum", plane: "front", axes: "XZ", offset: 0,
    })
    const { container } = render(() => (
      <ToastProvider>
        <PlanePicker field={field} value={value()} error={null} />
      </ToastProvider>
    ))
    expect(control(container).value).toBe("Front plane")
    setValue({ kind: "datum", plane: "top", axes: "XY", offset: 0 })
    expect(control(container).value).toBe("Top plane")
  })
})
