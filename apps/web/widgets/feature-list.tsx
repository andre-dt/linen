// =====================================================================
// apps/web/widgets/feature-list.tsx
//
// Reference to another feature: a profile to extrude, a path to sweep,
// sections to loft. `minimumItems` comes from metadata, so a loft can
// require two sections without this widget knowing what a loft is.
// =====================================================================

import { For, Show, createSignal } from "solid-js"
import { X } from "../icons"
import type { ReferenceField } from "@linen/cad/features"

interface Props {
  readonly field: ReferenceField
  readonly value: unknown
  readonly error: string | null
  readonly onChange?: (value: unknown) => void
}

export function FeatureList(props: Props) {
  const [chosen, setChosen] = createSignal<readonly string[]>([])

  const shortfall = () => {
    const minimum = props.field.minimumItems
    return minimum !== null && chosen().length < minimum
      ? `${minimum - chosen().length} more required`
      : null
  }

  return (
    <div class="widget widget-feature-list">
      <span class="widget-label">{props.field.label}</span>

      <Show
        when={chosen().length > 0}
        fallback={<p class="feature-list-empty">Select a {props.field.of}</p>}
      >
        <ul class="feature-list">
          <For each={chosen()}>
            {(id) => (
              <li class="feature-list-item">
                <span>{id}</span>
                <button
                  onClick={() => setChosen((current) => current.filter((e) => e !== id))}
                  aria-label="Remove"
                >
                  <X size={12} />
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={shortfall()}>
        {(message) => <span class="widget-hint">{message()}</span>}
      </Show>
    </div>
  )
}
