// =====================================================================
// apps/web/widgets/view-cube.tsx — a view picker that unfolds on hover.
//
// Collapsed, it is a single icon button with a tooltip. On hover it
// expands into a 3×3 matrix — the six faces of a cube laid out like an
// opened cardboard box (top/bottom/left/right/front centred, isometrics
// in the corners), each cell selecting that camera view.
//
//     ISO-TL │  TOP   │ ISO-TR
//     ──────────────────────────
//      LEFT  │ FRONT  │ RIGHT
//     ──────────────────────────
//     ISO-BL │ BOTTOM │ ISO-BR
//
// It reports the chosen view by id; wiring it to the camera is the
// viewer's job later.
// =====================================================================

import { For } from "solid-js"
import { Tooltip } from "@ark-ui/solid/tooltip"
import { LucideIcon } from "./lucide-icon"

export type ViewId =
  | "front" | "back" | "left" | "right" | "top" | "bottom"
  | "iso-tl" | "iso-tr" | "iso-bl" | "iso-br"

interface Cell {
  readonly id: ViewId
  readonly label: string
  /** The glyph shown in the cell — a face abbreviation or a corner mark. */
  readonly glyph: string
}

// Row-major, matching the unfolded-box layout above.
const CELLS: readonly Cell[] = [
  { id: "iso-tl", label: "Isometric",       glyph: "◤" },
  { id: "top",    label: "Top",             glyph: "TOP" },
  { id: "iso-tr", label: "Isometric",       glyph: "◥" },
  { id: "left",   label: "Left",            glyph: "L" },
  { id: "front",  label: "Front",           glyph: "F" },
  { id: "right",  label: "Right",           glyph: "R" },
  { id: "iso-bl", label: "Isometric",       glyph: "◣" },
  { id: "bottom", label: "Bottom",          glyph: "BOT" },
  { id: "iso-br", label: "Isometric",       glyph: "◢" },
]

export function ViewCube(props: { onSelect?: (view: ViewId) => void }) {
  return (
    <div class="view-cube">
      {/* Collapsed: the button. The matrix below is revealed on hover of
          this whole element (CSS), so the pointer can travel from the
          button into the grid without it closing. */}
      <Tooltip.Root openDelay={300}>
        <Tooltip.Trigger class="hud-tool view-cube-button" aria-label="Views">
          <LucideIcon name="box" size={18} />
        </Tooltip.Trigger>
        <Tooltip.Positioner>
          <Tooltip.Content class="tooltip">Views</Tooltip.Content>
        </Tooltip.Positioner>
      </Tooltip.Root>

      <div class="view-cube-grid hud-panel">
        <For each={CELLS}>
          {(cell) => (
            <button
              class="view-cube-cell"
              data-view={cell.id}
              title={cell.label}
              onClick={() => props.onSelect?.(cell.id)}
            >
              {cell.glyph}
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
