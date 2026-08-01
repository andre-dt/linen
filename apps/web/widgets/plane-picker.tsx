// =====================================================================
// apps/web/widgets/plane-picker.tsx
//
// Where a sketch gets drawn. A PLACEHOLDER, empty until filled: the field
// states what it wants and waits, rather than offering a menu of answers.
//
// TWO WAYS IN, AND ONLY TWO
// -------------------------
// Click a plane or planar face in the canvas, or pick a mate connector.
// That is the whole of it, as in Onshape — where the datum planes are
// GEOMETRY you click in the graphics area, not buttons in the panel.
//
// This replaced a grid of six named buttons (Top/Bottom/Front/…). They
// were a third path to the same value and a lie about where planes live:
// a user who learns to pick "Front" from a list has learned nothing about
// clicking the Front plane, which is the only way to pick the hundredth
// plane in a real model. One path, learned once, scales.
//
// EMPTY IS A STATE, NOT AN ERROR
// ------------------------------
// The placeholder reads as a slot awaiting content — dashed, quiet, and
// ARMED (the viewport pick is live) the moment the step is current. There
// is no "start picking" button to press first: the field being the
// current one IS the arming.
//
// Picking a FACE rather than a plane keeps the reference live: move the
// body and the sketch follows.
// =====================================================================

import { Show, createSignal } from "solid-js"
import type { PlaneField } from "@linen/cad/features"
import { DATUM_PLANES } from "@linen/viewer"
import { LucideIcon } from "./lucide-icon"
import { TooltipIconButton } from "./button"
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

export function PlanePicker(props: Props) {
  const [offsetOpen, setOffsetOpen] = createSignal(false)
  const toast = useToast()

  const current = (): PlaneValue | null => (props.value as PlaneValue | undefined) ?? null

  /** What the chosen reference is called. A datum is named by its view
   *  ("Front plane"); a face by the entity it came from, which is all
   *  there is to say until bodies carry names.
   *
   *  Looked up rather than cast: `plane` is a plain string because it
   *  arrives from persisted JSON, so a document written by an older
   *  version can name a plane this build does not have. Falling back to
   *  the raw id shows what is stored instead of mislabelling it. */
  const label = (value: PlaneValue): string => {
    if (value.kind === "face") return `Face ${value.face}`
    const found = DATUM_PLANES.find((plane) => plane.id === value.plane)
    return found ? `${found.label} plane` : value.plane
  }

  const clear = (): void => {
    props.onChange?.(undefined)
    setOffsetOpen(false)
  }

  const setOffset = (offset: number): void => {
    const value = current()
    if (!value) return
    props.onChange?.({ ...value, offset })
  }

  return (
    <div class="widget widget-plane" onFocusIn={() => props.onFocus?.()}>
      <span class="widget-label">{props.field.label}</span>

      {/* ONE ROW, both states. The mate button leads; the rest of the row
          is the slot — a prompt while empty, the chosen reference once
          filled. Same geometry either way, so choosing a plane does not
          resize the panel under the cursor. */}
      <div class="plane-row" data-filled={current() !== null}>
        {/* Icon only; "Mate connector" is the tooltip AND the accessible
            name, so the glyph is never the sole explanation. The subtle
            variant keeps it flat — a control inside a panel must not wear
            the panel's own material. */}
        <TooltipIconButton
          class="plane-mate"
          variant="hud-subtle"
          label="Mate connector"
          onClick={() =>
            toast.show("Mate connectors are not implemented yet.", { level: "info" })
          }
        >
          <LucideIcon name="anchor" size={14} />
        </TooltipIconButton>

        <Show
          when={current()}
          fallback={<span class="plane-slot">Select a plane or face</span>}
        >
          {(value) => (
            <>
              <span class="plane-slot filled">{label(value())}</span>
              <Show when={props.field.allowOffset}>
                <button
                  class="plane-offset"
                  aria-label="Offset"
                  data-selected={offsetOpen()}
                  onClick={() => setOffsetOpen(!offsetOpen())}
                >
                  <LucideIcon name="move-vertical" size={13} />
                </button>
              </Show>
              <button class="plane-clear" aria-label="Clear" onClick={clear}>
                <LucideIcon name="x" size={13} />
              </button>
            </>
          )}
        </Show>
      </div>

      <Show when={offsetOpen() && current()}>
        {(value) => (
          <label class="plane-offset-row">
            <span class="widget-sublabel">Offset</span>
            <input
              class="widget-input"
              value={String(value().offset)}
              onInput={(event) => setOffset(Number(event.currentTarget.value) || 0)}
            />
            <span class="widget-unit">mm</span>
          </label>
        )}
      </Show>
    </div>
  )
}
