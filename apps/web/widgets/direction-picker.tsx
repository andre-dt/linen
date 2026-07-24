// =====================================================================
// apps/web/widgets/direction-picker.tsx
//
// A direction is given three ways: a standard axis, an edge picked in
// the viewport, or explicit components. Flip is separate because
// reversing a direction is by far the most common correction.
// =====================================================================

import { createSignal, Show } from "solid-js"
import { ArrowLeftRight, MousePointerClick } from "lucide-solid"
import type { DirectionField } from "@linen/cad/features"

interface Props {
  readonly field: DirectionField
  readonly value: unknown
  readonly error: string | null
}

const AXES = [
  { label: "X", value: [1, 0, 0] as const },
  { label: "Y", value: [0, 1, 0] as const },
  { label: "Z", value: [0, 0, 1] as const },
]

export function DirectionPicker(props: Props) {
  const [flipped, setFlipped] = createSignal(false)

  return (
    <div class="widget widget-direction">
      <span class="widget-label">{props.field.label}</span>
      <div class="direction-row">
        {AXES.map((axis) => (
          <button class="direction-axis">{axis.label}</button>
        ))}

        <Show when={props.field.allowPick}>
          <button class="direction-pick" aria-label="Pick an edge">
            <MousePointerClick size={14} />
          </button>
        </Show>

        <Show when={props.field.allowFlip}>
          <button
            class="direction-flip"
            data-flipped={flipped()}
            onClick={() => setFlipped((current) => !current)}
            aria-label="Flip direction"
          >
            <ArrowLeftRight size={14} />
          </button>
        </Show>
      </div>
    </div>
  )
}
