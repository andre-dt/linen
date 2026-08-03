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
// The control is a READONLY input rather than a label: nothing is typed
// here — the value arrives from a canvas click, and the pick is armed the
// moment the step is current — but it still focuses, blinks a caret and
// tabs like the fields beside it, because it is one of them. The mate
// connector is this field's own extra button, which is exactly what a
// custom decorator is for.
//
// Picking a FACE rather than a plane keeps the reference live: move the
// body and the sketch follows.
// =====================================================================

import { Show, onMount, createEffect } from "solid-js"
import type { PlaneField } from "@linen/cad/features"
import { DATUM_PLANES } from "@linen/viewer"
import { LucideIcon } from "./lucide-icon"
import {
  FieldRoot, FieldBox, FieldClear, FieldIconButton, FieldPanelTrigger,
  FieldPanel, FieldPanelHeader,
} from "./field-parts"
import { useToast } from "../toast"

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
  let control!: HTMLInputElement
  onMount(() => {
    if (current() === null) control.focus()
  })

  // The displayed text, written as a PROPERTY rather than bound as the
  // `value` attribute. The attribute is only the element's default — the
  // browser applies it once, and from then on the DOM property is the
  // truth — so a field bound that way stops tracking the panel the moment
  // anything writes into it. Re-asserted on every change, the text cannot
  // drift from the value the panel holds.
  createEffect(() => {
    control.value = current() ? nameOf(current()!) : ""
  })

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
      <span class="widget-label">{props.field.label}</span>

      <FieldRoot
        invalid={props.error !== null}
        value={current() ?? undefined}
        onCommit={(value) => props.onChange?.(value)}
      >
        <FieldBox
          leading={
            <Show when={current()}>
              <LucideIcon name="square" size={14} />
            </Show>
          }
          control={
            // A real INPUT, not a label. The value is not typed — it comes
            // from a canvas click — but the field is still one of a column
            // of fields, and it should focus, carry a caret and tab like
            // the ones beside it. A span would be dead to the keyboard and
            // read as a different kind of thing.
            //
            // `readonly` rather than `disabled`: disabled would take it out
            // of the tab order and grey it out, which is the opposite of
            // what this field is — perfectly editable, just not by typing.
            <input
              ref={control}
              class="field-control"
              readonly
              placeholder="Select a plane or face"
              // The pick is armed by the step, so focusing the field is
              // enough; there is nothing to select or edit in the text.
              onFocus={() => props.onFocus?.()}
            />
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
