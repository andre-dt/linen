// =====================================================================
// apps/web/widgets/checkbox.tsx
// =====================================================================

import { Checkbox as Ark } from "@ark-ui/solid/checkbox"
import { Check } from "../icons"
import { Show } from "solid-js"
import type { BooleanField } from "@linen/cad/features"
import { Tooltip } from "@ark-ui/solid/tooltip"

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
      {/* `Ark.Label` — it associates the label with the control, which
          is what makes a click on the words toggle the box. Replacing
          it with a plain span took that away.
          
          The tooltip goes AROUND it rather than instead of it: Ark's
          own trigger wires onto the label element via `asChild`, so one
          element does both jobs. */}
      <Show
        when={props.field.help}
        fallback={<Ark.Label class="widget-label">{props.field.label}</Ark.Label>}
      >
        {(help) => (
          <Tooltip.Root openDelay={300}>
            <Tooltip.Trigger asChild={(tooltip) => (
              <Ark.Label {...tooltip()} class="widget-label">
                {props.field.label}
              </Ark.Label>
            )} />
            <Tooltip.Positioner>
              <Tooltip.Content class="tooltip">{help()}</Tooltip.Content>
            </Tooltip.Positioner>
          </Tooltip.Root>
        )}
      </Show>
      <Ark.HiddenInput />
    </Ark.Root>
  )
}
