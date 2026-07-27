// =====================================================================
// apps/web/widgets/plane-picker.tsx
//
// Where a sketch gets drawn: one of the six datum planes, a planar face,
// or either of those offset.
//
// NAMED BY VIEW, NOT BY AXIS PAIR
// -------------------------------
// Top / Bottom / Front / Back / Left / Right, as in Onshape — the user
// thinks "the top of the part", not "the XY plane". The axis plane each
// one means travels with the value, since the kernel speaks geometry
// rather than view names.
//
// Top and Bottom are the same geometric plane seen from opposite sides.
// Both are offered because the sketch's own orientation differs: which
// way is up in the two-dimensional space, and which way the normal
// points.
//
// TWO WAYS IN, ONE VALUE OUT
// --------------------------
// Clicking a button here and clicking the plane itself in the viewport
// produce exactly the same value. The buttons are the discoverable path;
// the viewport is the fast one. Focusing this widget ARMS the viewport
// pick, which is why picking is a property of the field rather than a
// mode the user has to enter.
//
// Picking a FACE rather than a plane keeps the reference live: move the
// body and the sketch follows.
// =====================================================================

import { Show, createSignal, For } from "solid-js"
import { MousePointerClick, MoveVertical } from "../icons"
import type { PlaneField } from "@linen/cad/features"
import { DATUM_PLANES } from "@linen/viewer"

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

  const current = (): PlaneValue | null => (props.value as PlaneValue | undefined) ?? null
  const isChosen = (id: string): boolean => {
    const value = current()
    return value?.kind === "datum" && value.plane === id
  }

  const choose = (id: string, axes: "XY" | "XZ" | "YZ"): void =>
    props.onChange?.({ kind: "datum", plane: id, axes, offset: current()?.offset ?? 0 })

  const setOffset = (offset: number): void => {
    const value = current()
    if (!value) return
    props.onChange?.({ ...value, offset })
  }

  return (
    <div class="widget widget-plane" onFocusIn={() => props.onFocus?.()}>
      <span class="widget-label">{props.field.label}</span>

      {/* Six named planes, sourced from the viewer's own table — the
          buttons and the clickable surfaces cannot drift apart, because
          there is one list. */}
      <div class="plane-grid">
        <For each={DATUM_PLANES}>
          {(plane) => (
            <button
              class="plane-standard"
              data-selected={isChosen(plane.id)}
              aria-pressed={isChosen(plane.id)}
              title={`${plane.label} (${plane.axes})`}
              onClick={() => choose(plane.id, plane.axes)}
            >
              {plane.label}
            </button>
          )}
        </For>
      </div>

      <div class="plane-row">
        <span class="widget-help plane-hint">or click a plane in the viewport</span>

        {/* Picking a planar face needs a body to pick on, and there is
            no kernel yet to produce one. Shown disabled: the step is
            real, only its input source is pending. */}
        <Show when={props.field.allowFace}>
          <button
            class="plane-pick"
            aria-label="Pick a planar face — needs a body"
            title="Pick a planar face — needs a body"
            disabled
          >
            <MousePointerClick size={14} />
          </button>
        </Show>

        <Show when={props.field.allowOffset}>
          <button
            class="plane-offset"
            aria-label="Offset"
            data-selected={offsetOpen()}
            disabled={current() === null}
            onClick={() => setOffsetOpen(!offsetOpen())}
          >
            <MoveVertical size={14} />
          </button>
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
