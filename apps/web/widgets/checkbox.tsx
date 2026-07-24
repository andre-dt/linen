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
}

export function Checkbox(props: Props) {
  return (
    <Ark.Root class="widget widget-checkbox" defaultChecked={props.field.default}>
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
