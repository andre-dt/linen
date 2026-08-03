// =====================================================================
// apps/web/widgets/dropdown.tsx
//
// A choice with too many options to sit side by side — the count decides,
// in command-panel.tsx, rather than each feature choosing.
//
// The FIELD PARTS are not used here, and that is deliberate. Their box
// puts the control and the buttons side by side as siblings; a select's
// whole box has to BE one trigger, because a field exposes exactly one
// combobox and a <button> cannot contain another. So this borrows the
// field's look through `.field-box` and supplies its own chevron in the
// place the shared trigger would have put it.
// =====================================================================

import { Select, createListCollection } from "@ark-ui/solid/select"
import { For, Show, createMemo } from "solid-js"
import type { ChoiceField } from "@linen/cad/features"
import { LucideIcon } from "./lucide-icon"

interface Props {
  readonly field: ChoiceField
  readonly value: unknown
  readonly error: string | null
  readonly onChange?: (value: unknown) => void
}

export function Dropdown(props: Props) {
  // A COLLECTION, not a plain array: Ark 4 takes its items this way, and
  // passing an array is what made this file the one that failed to
  // typecheck.
  const collection = createMemo(() =>
    createListCollection({
      items: props.field.options.map((option) => ({
        label: option.label,
        value: String(option.value),
      })),
    }),
  )

  const selected = createMemo(() =>
    props.value === undefined ? [] : [String(props.value)],
  )

  return (
    <div class="widget widget-dropdown">
      <Select.Root
        collection={collection()}
        value={selected()}
        onValueChange={(details) => props.onChange?.(details.value[0])}
        positioning={{ sameWidth: true, gutter: 4 }}
      >
        <Select.Label class="widget-label">{props.field.label}</Select.Label>
        <Select.Control>
          <Select.Trigger
            class="field-box field-box-trigger"
            classList={{ invalid: props.error !== null }}
          >
            <Select.ValueText class="field-value" placeholder="Choose" />
            <div class="field-decorators">
              <Select.Indicator class="field-icon-button field-chevron">
                <LucideIcon name="chevron-down" size={14} />
              </Select.Indicator>
            </div>
          </Select.Trigger>
        </Select.Control>

        <Select.Positioner>
          <Select.Content class="field-panel field-panel-list">
            <For each={collection().items}>
              {(item) => (
                <Select.Item item={item} class="field-option">
                  <Select.ItemText>{item.label}</Select.ItemText>
                  <Select.ItemIndicator class="field-option-check">
                    <LucideIcon name="check" size={13} />
                  </Select.ItemIndicator>
                </Select.Item>
              )}
            </For>
          </Select.Content>
        </Select.Positioner>
        <Select.HiddenSelect />
      </Select.Root>

      <Show when={props.field.help}>
        {(help) => <span class="widget-help">{help()}</span>}
      </Show>
    </div>
  )
}
