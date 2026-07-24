// =====================================================================
// apps/web/widgets/point-list.tsx
//
// Two-dimensional points on a face: hole positions, sketch clicks.
// Coordinates are EXPRESSIONS like every other value, so a hole can sit
// at `boltCircle` rather than at a frozen number.
// =====================================================================

import { For, Show, createSignal } from "solid-js"
import { X } from "lucide-solid"
import type { PointListField } from "@linen/cad/features"

interface Props {
  readonly field: PointListField
  readonly value: unknown
  readonly error: string | null
}

interface PointRow {
  readonly x: string
  readonly y: string
}

export function PointList(props: Props) {
  const [points, setPoints] = createSignal<readonly PointRow[]>([])

  return (
    <div class="widget widget-point-list">
      <span class="widget-label">{props.field.label}</span>

      <Show
        when={points().length > 0}
        fallback={<p class="point-list-empty">Click on the face to place points</p>}
      >
        <table class="point-list">
          <thead>
            <tr><th>X</th><th>Y</th><th /></tr>
          </thead>
          <tbody>
            <For each={points()}>
              {(point, index) => (
                <tr>
                  <td><input class="point-input" value={point.x} /></td>
                  <td><input class="point-input" value={point.y} /></td>
                  <td>
                    <button
                      onClick={() => setPoints((c) => c.filter((_, i) => i !== index()))}
                      aria-label="Remove point"
                    >
                      <X size={12} />
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  )
}
