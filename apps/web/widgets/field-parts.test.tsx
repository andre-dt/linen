// =====================================================================
// apps/web/widgets/field-parts.test.tsx
//
// The shared field skeleton. What is worth pinning is the part a reader
// would otherwise have to infer from six call sites: where the clear
// button sits, when it exists at all, and that the parts refuse to work
// outside their provider rather than silently doing nothing.
// =====================================================================

import { cleanup, render, fireEvent } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  FieldRoot, FieldBox, FieldClear, FieldIconButton, FieldPanelTrigger,
  FieldPanel, FieldPanelHeader, useField,
} from "./field-parts"

afterEach(() => cleanup())

/** A field with every kind of decorator, in the conventional order. */
function Probe(props: {
  readonly value?: unknown
  readonly onCommit?: (value: unknown) => void
  readonly onClear?: () => void
}) {
  // Spread rather than passed one by one: under exactOptionalPropertyTypes
  // an explicit `onCommit={undefined}` is not the same as omitting it.
  return (
    <FieldRoot {...props}>
      <FieldBox control={<span class="field-value">control</span>}>
        <FieldClear />
        <FieldIconButton label="Custom" icon="mouse-pointer-click" onClick={() => {}} />
        <FieldPanelTrigger />
      </FieldBox>
    </FieldRoot>
  )
}

const buttons = (container: HTMLElement): readonly string[] =>
  Array.from(container.querySelectorAll(".field-decorators button")).map(
    (node) => node.getAttribute("aria-label") ?? "",
  )

describe("field parts", () => {
  it("throws outside a provider, naming the one that is missing", () => {
    function Orphan() {
      useField()
      return null
    }
    expect(() => render(() => <Orphan />)).toThrow(
      "useField must be used inside <FieldRoot>",
    )
  })

  it("hides the clear button while the field has no value", () => {
    const { container } = render(() => <Probe />)
    expect(buttons(container)).toEqual(["Custom", "More settings"])
  })

  it("puts clear leftmost and the chevron last once there is a value", () => {
    const { container } = render(() => <Probe value="something" />)
    // The order is the contract: clear never appears under a cursor aimed
    // at the button beside it, and the chevron is always in one place.
    expect(buttons(container)).toEqual(["Clear", "Custom", "More settings"])
  })

  it("treats an explicit null as no value", () => {
    const { container } = render(() => <Probe value={null} />)
    expect(buttons(container)).not.toContain("Clear")
  })

  it("clears through onCommit(undefined) by default", () => {
    const onCommit = vi.fn()
    const { container } = render(() => <Probe value="x" onCommit={onCommit} />)
    fireEvent.click(container.querySelector('[aria-label="Clear"]')!)
    expect(onCommit).toHaveBeenCalledWith(undefined)
  })

  it("prefers onClear when the field distinguishes clearing from unsetting", () => {
    const onCommit = vi.fn()
    const onClear = vi.fn()
    const { container } = render(() => (
      <Probe value="x" onCommit={onCommit} onClear={onClear} />
    ))
    fireEvent.click(container.querySelector('[aria-label="Clear"]')!)
    expect(onClear).toHaveBeenCalledOnce()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("marks the box invalid so every field shows an error the same way", () => {
    const { container } = render(() => (
      <FieldRoot invalid>
        <FieldBox control={<span>control</span>} />
      </FieldRoot>
    ))
    expect(container.querySelector(".field-box")!.classList).toContain("invalid")
  })

  it("labels icon-only buttons, so a glyph is never the sole explanation", () => {
    const { container } = render(() => (
      <FieldRoot>
        <FieldBox control={<span>control</span>}>
          <FieldIconButton label="Mate connector" icon="mouse-pointer-click" onClick={() => {}} />
        </FieldBox>
      </FieldRoot>
    ))
    const button = container.querySelector(".field-decorators button")!
    expect(button.getAttribute("aria-label")).toBe("Mate connector")
    expect(button.getAttribute("title")).toBe("Mate connector")
  })

  it("opens the panel from the chevron, header rule and all", async () => {
    render(() => (
      <FieldRoot>
        <FieldBox control={<span>control</span>}>
          <FieldPanelTrigger />
        </FieldBox>
        <FieldPanel>
          <FieldPanelHeader>
            <FieldIconButton label="Header action" icon="mouse-pointer-click" onClick={() => {}} />
          </FieldPanelHeader>
          <p class="probe-content">panel content</p>
        </FieldPanel>
      </FieldRoot>
    ))

    // Lazily mounted: nothing of the panel exists until it is asked for.
    expect(document.querySelector(".probe-content")).toBeNull()

    fireEvent.click(document.querySelector('[aria-label="More settings"]')!)
    // The panel is portalled and mounts a frame later.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(document.querySelector(".probe-content")?.textContent).toBe("panel content")
    // The header brings its own separator, so every panel divides its
    // actions from its content the same way.
    expect(document.querySelector(".field-panel-rule")).not.toBeNull()
  })

  it("does not steal focus from the control when a decorator is pressed", () => {
    const onClick = vi.fn()
    const { container } = render(() => (
      <FieldRoot>
        <FieldBox control={<input class="field-control" />}>
          <FieldIconButton label="Custom" icon="mouse-pointer-click" onClick={onClick} />
        </FieldBox>
      </FieldRoot>
    ))
    const button = container.querySelector(".field-decorators button")!
    // A mousedown that is not prevented blurs the input the user is still
    // typing in — and, through the panel's own close-on-blur, hides the
    // panel that press just opened.
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})
