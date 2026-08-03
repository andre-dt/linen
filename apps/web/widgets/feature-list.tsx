// =====================================================================
// apps/web/widgets/feature-list.tsx
//
// Reference to another feature: a profile to extrude, a path to sweep,
// sections to loft. `minimumItems` comes from metadata, so a loft can
// require two sections without this widget knowing what a loft is.
//
// The BOX says how many are chosen and how many are still wanted; the
// PANEL lists them. Built from the shared field parts, so it is the same
// box as every other field — see widgets/field-parts.tsx.
// =====================================================================

import { For, Show } from "solid-js"
import type { ReferenceField } from "@linen/cad/features"
import {
  FieldRoot, FieldBox, FieldClear, FieldIconButton, FieldPanelTrigger,
  FieldPanel,
} from "./field-parts"

interface Props {
  readonly field: ReferenceField
  readonly value: unknown
  readonly error: string | null
  readonly onChange?: (value: unknown) => void
}

export function FeatureList(props: Props) {
  const chosen = (): readonly string[] =>
    Array.isArray(props.value) ? (props.value as readonly string[]) : []

  /** How many more the field declares it needs. Shown as PROGRESS rather
   *  than as an error: a half-filled loft is a normal state on the way to
   *  a full one, not a mistake to correct. */
  const shortfall = (): string | null => {
    const minimum = props.field.minimumItems
    if (minimum === null || chosen().length >= minimum) return null
    return `${minimum - chosen().length} more required`
  }

  const summary = (): string => {
    const count = chosen().length
    if (count === 1) return chosen()[0]!
    return `${count} ${props.field.of}s`
  }

  const remove = (id: string): void =>
    props.onChange?.(chosen().filter((current) => current !== id))

  return (
    <div class="widget widget-feature-list">
      <span class="widget-label">{props.field.label}</span>

      <FieldRoot
        invalid={props.error !== null}
        value={chosen().length > 0 ? chosen() : undefined}
        onCommit={(value) => props.onChange?.(value)}
        onClear={() => props.onChange?.([])}
      >
        <FieldBox
          control={
            <Show
              when={chosen().length > 0}
              fallback={
                <span class="field-value empty">Select a {props.field.of}</span>
              }
            >
              <span class="field-value">{summary()}</span>
            </Show>
          }
        >
          <FieldClear label="Clear references" />
          <FieldPanelTrigger label="Chosen references" />
        </FieldBox>

        <FieldPanel>
          <Show
            when={chosen().length > 0}
            fallback={
              <p class="field-panel-empty">
                Select a {props.field.of} in the outline or the viewport.
              </p>
            }
          >
            <ul class="field-panel-items">
              <For each={chosen()}>
                {(id) => (
                  <li class="field-panel-item">
                    <span class="field-panel-item-name">{id}</span>
                    <FieldIconButton
                      label={`Remove ${id}`}
                      icon="x"
                      onClick={() => remove(id)}
                    />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </FieldPanel>
      </FieldRoot>

      {/* Outside the field: it is about the step's progress, not about
          the value in the box. */}
      <Show when={shortfall()}>
        {(message) => <span class="widget-hint">{message()}</span>}
      </Show>
    </div>
  )
}
