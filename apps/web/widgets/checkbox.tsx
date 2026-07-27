// =====================================================================
// apps/web/widgets/checkbox.tsx
// =====================================================================

import { Checkbox as Ark } from "@ark-ui/solid/checkbox"
import { Check } from "../icons"
import { Show } from "solid-js"
import type { BooleanField } from "@linen/cad/features"

interface Props {
  readonly field: BooleanField
  readonly value: unknown
  readonly error: string | null
  readonly onChange?: (value: unknown) => void
}

export function Checkbox(props: Props) {
  return (
    <Ark.Root
      class="widget widget-checkbox"
      // Controlled by the panel, not by the widget: the value in the
      // panel state is the truth, so stepping back and forward shows
      // what was actually entered.
      checked={props.value === undefined ? props.field.default : props.value === true}
      onCheckedChange={(details) => props.onChange?.(details.checked === true)}
    >
      <Ark.Control class="checkbox-control">
        <Ark.Indicator>
          <Check size={12} />
        </Ark.Indicator>
      </Ark.Control>
      <Ark.Label class="widget-label">{props.field.label}</Ark.Label>
      <Ark.HiddenInput />
      <Show when={props.field.help}>
        {(help) => <span class="widget-help">{help()}</span>}
      </Show>
    </Ark.Root>
  )
}
