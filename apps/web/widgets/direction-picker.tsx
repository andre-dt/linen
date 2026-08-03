// =====================================================================
// apps/web/widgets/direction-picker.tsx
//
// A direction is given three ways: a standard axis, an edge picked in
// the viewport, or explicit components. Flip is separate because
// reversing a direction is by far the most common correction — so it is
// a decorator on the field rather than something to open a panel for.
//
// The axes move INTO the panel: three buttons in the box would leave no
// room for the value, and picking an axis is a choice made once while
// flipping is a correction made repeatedly. See widgets/field-parts.tsx.
// =====================================================================

import { For, Show } from "solid-js"
import type { DirectionField } from "@linen/cad/features"
import {
  FieldRoot, FieldBox, FieldClear, FieldIconButton, FieldPanelTrigger,
  FieldPanel, FieldPanelHeader,
} from "./field-parts"
import { useToast } from "../toast"

interface Props {
  readonly field: DirectionField
  readonly value: unknown
  readonly error: string | null
  readonly onChange?: (value: unknown) => void
}

/** A direction, as stored: three components in the kernel's frame. */
type Direction = readonly [number, number, number]

const AXES: readonly { readonly label: string; readonly value: Direction }[] = [
  { label: "X", value: [1, 0, 0] },
  { label: "Y", value: [0, 1, 0] },
  { label: "Z", value: [0, 0, 1] },
]

/** Which standard axis this direction lies along, if any. Compared on
 *  absolute components so a flipped axis is still recognised as that
 *  axis — "−Z" is Z reversed, not an arbitrary direction. */
const axisOf = (value: Direction): string | null =>
  AXES.find(
    (entry) =>
      entry.value[0] === Math.abs(value[0]) &&
      entry.value[1] === Math.abs(value[1]) &&
      entry.value[2] === Math.abs(value[2]),
  )?.label ?? null

/** What a chosen direction is called. A standard axis is named; anything
 *  else is shown as its components, which is all there is to say about a
 *  direction taken off an edge. */
const nameOf = (value: Direction): string => {
  const axis = axisOf(value)
  if (!axis) return value.map((component) => component.toFixed(2)).join(", ")
  const negative = value[0] + value[1] + value[2] < 0
  return `${negative ? "−" : ""}${axis}`
}

export function DirectionPicker(props: Props) {
  const toast = useToast()
  const current = (): Direction | null => (props.value as Direction | undefined) ?? null

  const flip = (): void => {
    const value = current()
    if (!value) return
    props.onChange?.([-value[0], -value[1], -value[2]] as Direction)
  }

  return (
    <div class="widget widget-direction">
      <span class="widget-label">{props.field.label}</span>

      <FieldRoot
        invalid={props.error !== null}
        value={current() ?? undefined}
        onCommit={(value) => props.onChange?.(value)}
      >
        <FieldBox
          control={
            <Show
              when={current()}
              fallback={<span class="field-value empty">No direction</span>}
            >
              {(value) => <span class="field-value">{nameOf(value())}</span>}
            </Show>
          }
        >
          <FieldClear label="Clear direction" />
          {/* Flip is the common correction, so it stays one click away
              rather than behind the chevron. Only meaningful once there
              is a direction to reverse. */}
          <Show when={props.field.allowFlip && current() !== null}>
            <FieldIconButton
              label="Flip direction"
              icon="arrow-left-right"
              onClick={flip}
            />
          </Show>
          <FieldPanelTrigger label="Direction options" />
        </FieldBox>

        <FieldPanel>
          <Show when={props.field.allowPick}>
            <FieldPanelHeader>
              <FieldIconButton
                label="Pick an edge"
                icon="mouse-pointer-click"
                onClick={() =>
                  toast.show("Edge picking needs a body — pending the kernel.", {
                    level: "info",
                  })
                }
              />
            </FieldPanelHeader>
          </Show>

          <div class="field-chip-row">
            <For each={AXES}>
              {(axis) => {
                const chosen = (): boolean => {
                  const value = current()
                  return value !== null && axisOf(value) === axis.label
                }
                return (
                  <button
                    class="field-chip"
                    data-selected={chosen()}
                    aria-pressed={chosen()}
                    onClick={() => props.onChange?.(axis.value)}
                  >
                    {axis.label}
                  </button>
                )
              }}
            </For>
          </div>
        </FieldPanel>
      </FieldRoot>
    </div>
  )
}
