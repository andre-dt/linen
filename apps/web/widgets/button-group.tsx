// =====================================================================
// apps/web/widgets/button-group.tsx
//
// Mutually exclusive options, shown side by side. Used when a choice has
// few enough options to stay visible — beyond that the panel switches to
// a dropdown, a decision made by count in command-panel.tsx rather than
// by each feature.
// =====================================================================

import { For } from "solid-js"
import type { ChoiceField } from "@linen/cad/features"
import { WidgetLabel } from "./widget-label"

interface Props {
  readonly field: ChoiceField
  readonly value: unknown
  readonly error: string | null
  readonly onChange?: (value: unknown) => void
}

export function ButtonGroup(props: Props) {
  return (
    <div class="widget widget-button-group">
      <WidgetLabel label={props.field.label} help={props.field.help} />
      <div class="button-group" role="radiogroup" aria-label={props.field.label}>
        <For each={props.field.options}>
          {(option) => (
            <button
              class="button-group-item"
              role="radio"
              aria-checked={props.value === option.value}
              data-selected={props.value === option.value}
              onClick={() => props.onChange?.(option.value)}
            >
              {option.label}
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
