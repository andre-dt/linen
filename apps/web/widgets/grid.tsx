// =====================================================================
// apps/web/widgets/grid.tsx
//
// An editable table: variable fillet stops, configuration rows. Columns
// come from metadata, including their dimension, so cells accept
// expressions where the column is dimensional.
// =====================================================================

import { For, createSignal } from "solid-js"
import { Plus, X } from "../icons"
import type { TableField } from "@linen/cad/features"
import { WidgetLabel } from "./widget-label"

interface Props {
  readonly field: TableField
  readonly value: unknown
  readonly error: string | null
  readonly onChange?: (value: unknown) => void
}

export function Grid(props: Props) {
  const [rows, setRows] = createSignal<readonly Record<string, string>[]>([])

  const addRow = () =>
    setRows((current) => [
      ...current,
      Object.fromEntries(props.field.columns.map((column) => [column.name, ""])),
    ])

  return (
    <div class="widget widget-grid">
      <WidgetLabel label={props.field.label} help={props.field.help} />

      <table class="grid">
        <thead>
          <tr>
            <For each={props.field.columns}>{(column) => <th>{column.label}</th>}</For>
            <th />
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(row, index) => (
              <tr>
                <For each={props.field.columns}>
                  {(column) => (
                    <td><input class="grid-input" value={row[column.name] ?? ""} /></td>
                  )}
                </For>
                <td>
                  <button
                    onClick={() => setRows((c) => c.filter((_, i) => i !== index()))}
                    aria-label="Remove row"
                  >
                    <X size={12} />
                  </button>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>

      <button class="grid-add" onClick={addRow}>
        <Plus size={12} /> Add
      </button>
    </div>
  )
}
