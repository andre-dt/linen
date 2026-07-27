// =====================================================================
// apps/web/widgets/view-cube.tsx — a FLOATING, draggable view picker.
//
// A standalone control — not a HUD panel. It floats over the canvas at a
// position the user chooses by dragging it; that position is saved to
// localStorage, so it stays where they put it across reloads.
//
// Collapsed, it is a single icon button. On hover it unfolds into a 3×3
// matrix — the six faces of a cube laid out like an opened cardboard box
// (top/bottom/left/right/front centred, isometrics in the corners), each
// cell selecting that camera view. The matrix is centred ON the button, so
// its middle cell (FRONT) sits exactly over it and it blooms evenly to
// every side. Floating free, it never clips into another panel.
//
//     ISO-TL │  TOP   │ ISO-TR
//     ──────────────────────────
//      LEFT  │ FRONT  │ RIGHT
//     ──────────────────────────
//     ISO-BL │ BOTTOM │ ISO-BR
//
// It reports the chosen view by id; wiring it to the camera is the
// viewer's job later.
//
// CLICK vs DRAG
// -------------
// The button both opens views (on hover) and is the drag handle. A small
// movement threshold separates the two: a press that moves less than a few
// pixels before release is a plain interaction (hover/click still work); a
// press that moves past the threshold becomes a drag and is not a click.
// =====================================================================

import { For, createSignal, onMount, onCleanup } from "solid-js"
import { LucideIcon } from "./lucide-icon"
import { BaseButton, ViewButton, VIEW_CELL_SIZE } from "./button"

export type ViewId =
  | "front" | "back" | "left" | "right" | "top" | "bottom"
  | "iso-tl" | "iso-tr" | "iso-bl" | "iso-br"

interface Cell {
  readonly id: ViewId
  readonly label: string
  /** What the cell shows — the view's full name, or a corner mark for the
   *  isometrics, whose names would not fit and whose glyph reads better. */
  readonly glyph: string
}

// Row-major, matching the unfolded-box layout above. The six faces spell
// their names out in full rather than abbreviating: "BOT" and a lone "F"
// are guesses the user has to decode, and the cell is wide enough for the
// word at a small type size.
const CELLS: readonly Cell[] = [
  { id: "iso-tl", label: "Isometric", glyph: "◤" },
  { id: "top",    label: "Top",       glyph: "TOP" },
  { id: "iso-tr", label: "Isometric", glyph: "◥" },
  { id: "left",   label: "Left",      glyph: "LEFT" },
  { id: "front",  label: "Front",     glyph: "FRONT" },
  { id: "right",  label: "Right",     glyph: "RIGHT" },
  { id: "iso-bl", label: "Isometric", glyph: "◣" },
  { id: "bottom", label: "Bottom",    glyph: "BOTTOM" },
  { id: "iso-br", label: "Isometric", glyph: "◢" },
]

interface Position {
  readonly x: number
  readonly y: number
}

const STORAGE_KEY = "linen.view-cube.position"
// Movement past this (in px) turns a press into a drag, not a click.
const DRAG_THRESHOLD = 3
// The button's footprint, used to keep it clamped inside the viewport.
// Taken from the button module — sizing is its business, not ours.
const BUTTON_SIZE = VIEW_CELL_SIZE
// The flower's geometry, mirroring --view-cell / --view-cell-gap and the
// grid padding in the stylesheet. Derived rather than hard-coded so that
// resizing a cell or widening the gap cannot silently desync the clamp that
// keeps the flower on screen.
const CELL_GAP = 6
const GRID_PADDING = 6
// Cells are the same size as the trigger — that is what lets FRONT cover it.
const FLOWER_SIZE = BUTTON_SIZE * 3 + CELL_GAP * 2 + GRID_PADDING * 2
// The flower is centred ON the button, so it reaches this far past it on
// every side. Keeping that much margin means it never crops, wherever the
// user parks the button.
const FLOWER_OVERHANG = (FLOWER_SIZE - BUTTON_SIZE) / 2

const readPosition = (): Position | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Position>
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null
    return { x: parsed.x, y: parsed.y }
  } catch {
    return null
  }
}
const writePosition = (position: Position): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(position))
  } catch {
    // storage unavailable — dragging still works, just without memory
  }
}

// The default spot before the user has ever moved it: upper right, below
// the session chip in the top row. Held FLOWER_OVERHANG in from the right
// edge so the flower has room to bloom without cropping — further in than
// a plain button would need, because the expanded matrix is what has to
// fit, not the button.
const defaultPosition = (): Position => ({
  x: Math.max(0, window.innerWidth - BUTTON_SIZE - FLOWER_OVERHANG),
  y: 96,
})

// Clamp to the band where the flower still fits: FLOWER_OVERHANG in from
// each edge. If the viewport is too small for that band, fall back to the
// centre rather than inverting the bounds.
const clamp = (value: number, extent: number): number => {
  const minimum = FLOWER_OVERHANG
  const maximum = extent - BUTTON_SIZE - FLOWER_OVERHANG
  if (maximum < minimum) return Math.max(0, (extent - BUTTON_SIZE) / 2)
  return Math.min(Math.max(minimum, value), maximum)
}

export function ViewCube(props: { onSelect?: (view: ViewId) => void }) {
  const [position, setPosition] = createSignal<Position>(readPosition() ?? defaultPosition())
  // True while a drag is in progress — suppresses the trailing click so a
  // drag never also selects a view, and disables the hover-to-open flower.
  const [dragging, setDragging] = createSignal(false)
  // Whether the flower is unfolded. State rather than CSS :hover, because
  // the flower extends well outside the wrapper's own box — see the markup.
  const [open, setOpen] = createSignal(false)

  // Keep it inside the viewport if the window shrinks below its position.
  const onResize = (): void => {
    const current = position()
    setPosition({
      x: clamp(current.x, window.innerWidth),
      y: clamp(current.y, window.innerHeight),
    })
  }
  onMount(() => window.addEventListener("resize", onResize))
  onCleanup(() => window.removeEventListener("resize", onResize))

  // Click-away also closes it, for the case where the pointer never
  // crosses the control's edge — a press straight onto the canvas.
  // Bound to the capture phase on document so it still sees presses that a
  // stopPropagation somewhere in between would otherwise hide.
  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (!open()) return
    const target = event.target as Element | null
    if (target?.closest(".view-cube")) return
    setOpen(false)
  }
  onMount(() => document.addEventListener("pointerdown", onDocumentPointerDown, true))
  onCleanup(() => document.removeEventListener("pointerdown", onDocumentPointerDown, true))

  const onPointerDown = (event: PointerEvent): void => {
    // Only the primary button drags; let others (context menu) through.
    if (event.button !== 0) return
    const origin = position()
    const startX = event.clientX
    const startY = event.clientY
    let moved = false

    // The gesture is tracked on WINDOW, not via setPointerCapture on the
    // button. The button is rendered through Ark's `asChild`, which does not
    // forward a ref; dragging calls setDragging, and a re-render can then
    // swap the node out mid-gesture, taking its capture and listeners with
    // it — the drag would die after the first pixel. Window listeners belong
    // to no element, so nothing can strand them.
    const onMove = (move: PointerEvent): void => {
      const deltaX = move.clientX - startX
      const deltaY = move.clientY - startY
      if (!moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return
      moved = true
      setDragging(true)
      setPosition({
        x: clamp(origin.x + deltaX, window.innerWidth),
        y: clamp(origin.y + deltaY, window.innerHeight),
      })
    }
    const onUp = (event: PointerEvent): void => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      if (moved) {
        writePosition(position())
        // A drag suppresses the leave handler, so the flower can end up
        // open with the pointer nowhere near it. Resolve that here, by
        // where the pointer ACTUALLY finished: inside, it stays open and
        // the leave handler takes over again; outside, it closes now.
        const under = document.elementFromPoint(event.clientX, event.clientY)
        if (!under?.closest(".view-cube")) setOpen(false)
        // Clear the drag flag AFTER the click event would fire, so the
        // click that ends a drag is swallowed rather than selecting a view.
        setTimeout(() => setDragging(false), 0)
      }
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  return (
    <div
      class="view-cube-slot"
      classList={{ dragging: dragging() }}
      style={{ left: `${position().x}px`, top: `${position().y}px` }}
    >
      {/* The drag is armed on THIS wrapper, which encloses both states — the
          collapsed button and the open flower. Grabbing any part of the
          control moves it, so the user does not have to close the flower (or
          hunt for the trigger beneath it) just to reposition the thing.

          The flower opens on hover and closes when the pointer leaves,
          the way a menu should. The one exception is a DRAG: the pointer
          routinely outruns the control while moving it, and folding up
          mid-gesture would yank the thing out from under the cursor. */}
      <div
        class="view-cube"
        classList={{ open: open() }}
        onPointerDown={onPointerDown}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => { if (!dragging()) setOpen(false) }}
      >
        {/* The button is both the drag handle and the flower trigger; the
            gesture itself is tracked on window (see onPointerDown). */}
        {/* The button opens the flower. It has to be the one to do it: while
            closed the wrapper is deliberately inert (so its 192px box does
            not swallow canvas clicks around this small button), and an inert
            element receives no pointerenter. Once open, the wrapper takes
            over and owns the leave. */}
        <ViewButton
          label="Views (drag to move)"
          size={VIEW_CELL_SIZE}
          onPointerEnter={() => setOpen(true)}
        >
          <LucideIcon name="box" size={18} />
        </ViewButton>

        <div class="view-cube-grid">
          <For each={CELLS}>
            {(cell) => (
              <BaseButton
                variant="hud-icon"
                size={VIEW_CELL_SIZE}
                class="view-cube-cell"
                data-view={cell.id}
                title={cell.label}
                onClick={() => {
                  // Swallow the click that terminates a drag.
                  if (dragging()) return
                  props.onSelect?.(cell.id)
                }}
              >
                {cell.glyph}
              </BaseButton>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
