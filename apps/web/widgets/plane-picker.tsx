// =====================================================================
// apps/web/widgets/plane-picker.tsx
//
// Where a sketch gets drawn. Built from the shared field parts, so it is
// the same box, the same button sizes and the same panel as every other
// field — see widgets/field-parts.tsx.
//
//   [◱] Front plane                      [✕] [⌖] [⌄]
//
// TWO WAYS IN, AND ONLY TWO
// -------------------------
// Click a plane or planar face in the canvas, or pick a mate connector.
// That is the whole of it, as in Onshape — where the datum planes are
// GEOMETRY you click in the graphics area, not entries in a list. A user
// who learns to pick "Front" from a menu has learned nothing about
// clicking the hundredth plane in a real model; one path, learned once,
// scales.
//
// The control shows text and takes no keyboard: nothing is typed here —
// the value arrives from a canvas click, and the pick is armed the
// moment the step is current. So it is a span, not an input. An input
// would sit in the tab order and blink a caret, promising an
// interaction this field does not have. The mate connector is this
// field's own extra button, which is exactly what a custom decorator is
// for.
//
// Picking a FACE rather than a plane keeps the reference live: move the
// body and the sketch follows.
// =====================================================================

import { Show } from "solid-js"
import type { PlaneField } from "@linen/cad/features"
import { DATUM_PLANES } from "@linen/viewer"
import {
  FieldRoot, FieldBox, FieldClear, FieldIconButton, FieldPanelTrigger,
  FieldPanel, FieldPanelHeader,
} from "./field-parts"
import { useToast } from "../toast"
import { WidgetLabel } from "./widget-label"

/** The value this widget produces. Serializable, and shaped like the
 *  PlaneReference the draft input persists. */
export type PlaneValue =
  | {
      readonly kind: "datum"
      /** The view name: "top", "front", … */
      readonly plane: string
      /** The axis plane it lies in — what the kernel actually needs. */
      readonly axes: "XY" | "XZ" | "YZ"
      readonly offset: number
    }
  | { readonly kind: "face"; readonly face: string; readonly offset: number }

interface Props {
  readonly field: PlaneField
  readonly value: unknown
  readonly error: string | null
  readonly onChange?: (value: unknown) => void
  /** Arms the viewport pick for this field. */
  readonly onFocus?: () => void
}

/**
 * What the chosen reference is called. A datum is named by its view
 * ("Front plane"); a face by the entity it came from, which is all there
 * is to say until bodies carry names.
 *
 * Looked up rather than cast: `plane` is a plain string because it
 * arrives from persisted JSON, so a document written by an older version
 * can name a plane this build does not have. Falling back to the raw id
 * shows what is stored instead of mislabelling it.
 */
const nameOf = (value: PlaneValue): string => {
  if (value.kind === "face") return `Face ${value.face}`
  const found = DATUM_PLANES.find((plane) => plane.id === value.plane)
  return found ? `${found.label} plane` : value.plane
}

export function PlanePicker(props: Props) {
  const toast = useToast()
  const current = (): PlaneValue | null => (props.value as PlaneValue | undefined) ?? null

  // Focused on mount, so the caret is blinking the moment the step opens.
  // The pick is already armed by then — the field being current IS the
  // arming — and a caret with nothing focused would be a promise the
  // panel had not kept. Only when still empty: a step revisited to change
  // something else should not yank focus back here.

  const setOffset = (offset: number): void => {
    const value = current()
    if (!value) return
    props.onChange?.({ ...value, offset })
  }

  const notImplemented = (): void => {
    toast.show("Mate connectors are not implemented yet.", { level: "info" })
  }

  return (
    <div class="widget widget-plane" onFocusIn={() => props.onFocus?.()}>
      <WidgetLabel label={props.field.label} help={props.field.help} />

      <FieldRoot
        invalid={props.error !== null}
        value={current() ?? undefined}
        onCommit={(value) => props.onChange?.(value)}
      >
        <FieldBox
          // No leading glyph.
          //
          // It was a `square`, which is what a checkbox looks like — so
          // a field holding "Right plane" read as an unchecked box
          // labelled with a plane's name. The icon carried no
          // information either: it was the same square for every plane,
          // present only when a value was set, which the text already
          // says.
          control={
            // A SPAN, not an input.
            //
            // Nothing here is typed, selected or tabbed to: the value
            // comes from a canvas click, and the step decides when the
            // pick is armed. An input — even readonly — sits in the tab
            // order, takes a caret and answers the keyboard, all of
            // which promise an interaction this field does not have.
            //
            // The panel's fields read as labels that happen to hold a
            // value, and the keyboard walks past them to the controls
            // that actually take one.
            <span class="field-value" classList={{ empty: current() === null }}>
              {current() === null ? "Select a plane or face" : nameOf(current()!)}
            </span>
          }
        >
          {/* Clear first — it renders itself only when there is a value,
              so the buttons beside it never shift under the cursor. */}
          <FieldClear label="Clear plane" />
          <FieldIconButton
            label="Mate connector"
            icon="mouse-pointer-2"
            onClick={notImplemented}
          />
          <FieldPanelTrigger label="Plane options" />
        </FieldBox>

        <FieldPanel>
          <FieldPanelHeader>
            <FieldIconButton
              label="Mate connector"
              icon="mouse-pointer-2"
              onClick={notImplemented}
            />
          </FieldPanelHeader>

          <Show
            when={current()}
            fallback={
              <p class="field-panel-empty">
                Select a plane or planar face in the canvas first.
              </p>
            }
          >
            {(value) => (
              <Show
                when={props.field.allowOffset}
                fallback={<p class="field-panel-empty">No options for this plane.</p>}
              >
                <label class="field-panel-row">
                  <span class="widget-sublabel">Offset</span>
                  <input
                    class="widget-input"
                    value={String(value().offset)}
                    onInput={(event) => setOffset(Number(event.currentTarget.value) || 0)}
                  />
                  <span class="widget-unit">mm</span>
                </label>
              </Show>
            )}
          </Show>
        </FieldPanel>
      </FieldRoot>
    </div>
  )
}
