// =====================================================================
// apps/web/widgets/point-list.tsx
//
// Two-dimensional points on the plane chosen upstream: the curve tools'
// clicks, hole positions. Coordinates are EXPRESSIONS like every other
// value, so a point can sit at `boltCircle` rather than at a frozen
// number — which is why each cell is text, not a number input.
//
// The points live in the PANEL, not here. A widget holding its own copy
// would lose them the moment the user stepped back to change the plane,
// and the panel state is what eventually becomes the persisted input.
//
// Placing points by clicking the viewport is the intended path; the
// viewer does not report picks yet, so rows can also be added by hand.
// Both write the same value.
// =====================================================================

import { For, Show } from "solid-js"
import { X } from "../icons"
import type { PointListField } from "@linen/cad/features"

/** One point, as stored. Strings because they are expressions. */
export interface PointRow {
  readonly x: string
  readonly y: string
}

interface Props {
  readonly field: PointListField
  readonly value: unknown
  readonly error: string | null
  readonly onChange?: (value: unknown) => void
}

export function PointList(props: Props) {
  const points = (): readonly PointRow[] =>
    Array.isArray(props.value) ? (props.value as readonly PointRow[]) : []

  const write = (next: readonly PointRow[]): void => props.onChange?.(next)

  const add = (): void => write([...points(), { x: "0", y: "0" }])

  const edit = (index: number, axis: "x" | "y", text: string): void =>
    write(points().map((point, at) => (at === index ? { ...point, [axis]: text } : point)))

  const remove = (index: number): void =>
    write(points().filter((_, at) => at !== index))

  // The declared minimum, shown as progress rather than as an error:
  // a half-drawn line is a normal state, not a mistake.
  const shortBy = (): number => Math.max(0, props.field.minimumItems - points().length)

  return (
    <div class="widget widget-point-list">
      <span class="widget-label">{props.field.label}</span>

      <Show
        when={points().length > 0}
        fallback={
          <p class="point-list-empty">
            Click on the plane to place points — viewport pending.
          </p>
        }
      >
        <table class="point-list">
          <thead>
            <tr><th>X</th><th>Y</th><th /></tr>
          </thead>
          <tbody>
            <For each={points()}>
              {(point, index) => (
                <tr>
                  <td>
                    <input
                      class="point-input"
                      value={point.x}
                      onInput={(event) => edit(index(), "x", event.currentTarget.value)}
                    />
                  </td>
                  <td>
                    <input
                      class="point-input"
                      value={point.y}
                      onInput={(event) => edit(index(), "y", event.currentTarget.value)}
                    />
                  </td>
                  <td>
                    <button onClick={() => remove(index())} aria-label="Remove point">
                      <X size={12} />
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>

      <div class="point-list-foot">
        <button class="point-list-add" onClick={add}>Add point</button>
        <Show when={shortBy() > 0}>
          <span class="widget-help">
            {shortBy()} more {shortBy() === 1 ? "point" : "points"} needed
          </span>
        </Show>
      </div>
    </div>
  )
}
