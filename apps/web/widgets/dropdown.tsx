// =====================================================================
// apps/web/widgets/dropdown.tsx
// =====================================================================

import { Select } from "@ark-ui/solid/select"
import { ChevronDown } from "lucide-solid"
import { For, createMemo } from "solid-js"
import type { ChoiceField } from "@linen/cad/features"

interface Props {
  readonly field: ChoiceField
  readonly value: unknown
  readonly error: string | null
}

export function Dropdown(props: Props) {
  const items = createMemo(() =>
    props.field.options.map((option) => ({ label: option.label, value: option.value })),
  )

  return (
    <Select.Root class="widget widget-dropdown" items={items()} positioning={{ sameWidth: true }}>
      <Select.Label class="widget-label">{props.field.label}</Select.Label>
      <Select.Control>
        <Select.Trigger class="dropdown-trigger">
          <Select.ValueText placeholder="Choose" />
          <Select.Indicator>
            <ChevronDown size={14} />
          </Select.Indicator>
        </Select.Trigger>
      </Select.Control>
      <Select.Positioner>
        <Select.Content class="dropdown-content">
          <For each={items()}>
            {(item) => (
              <Select.Item item={item} class="dropdown-item">
                <Select.ItemText>{item.label}</Select.ItemText>
              </Select.Item>
            )}
          </For>
        </Select.Content>
      </Select.Positioner>
      <Select.HiddenSelect />
    </Select.Root>
  )
}
