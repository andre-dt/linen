// =====================================================================
// apps/web/panels/variables.tsx
//
// Where parametric editing actually happens. Change one value and every
// feature downstream regenerates.
//
// Values are shown AS WRITTEN, not as evaluated: a variable defined as
// `outerDiameter / 4` must keep reading that way, because the formula is
// the thing worth seeing. The result goes beside it, greyed.
//
// Derived variables are read-only — editing one would mean editing the
// expression that produces it.
// =====================================================================

import { For, Show } from "solid-js"
import { Plus, Variable } from "../icons"
import type { Session } from "../session"

interface VariablesProps {
  readonly session: Session
}

interface VariableRow {
  readonly name: string
  readonly text: string
  readonly evaluated: string
  readonly unit: string | null
  readonly editable: boolean
}

export function Variables(props: VariablesProps) {
  // TODO: read from the session once the variable channel lands.
  const rows = (): readonly VariableRow[] => []

  return (
    <section class="variables">
      <header class="sidebar-header">
        <Variable size={14} />
        <span>Variables</span>
        <button class="sidebar-action" aria-label="Add variable">
          <Plus size={12} />
        </button>
      </header>

      <Show
        when={rows().length > 0}
        fallback={<p class="sidebar-empty">No variables yet</p>}
      >
        <ul class="variable-list">
          <For each={rows()}>
            {(row) => (
              <li class="variable-row" data-readonly={!row.editable}>
                <span class="variable-name">{row.name}</span>
                <input
                  class="variable-input"
                  value={row.text}
                  readOnly={!row.editable}
                  spellcheck={false}
                />
                <Show when={row.text !== row.evaluated}>
                  <span class="variable-evaluated">
                    {row.evaluated}{row.unit}
                  </span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
