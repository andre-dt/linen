// =====================================================================
// apps/web/widgets/split-button.tsx — a default action plus a menu.
//
// The left part runs the primary action on click; the chevron on the
// right opens a menu of alternatives. Generic and reusable: it takes a
// label, a primary handler, and a list of extra actions — it knows
// nothing about parts or modules.
//
//   [ New part | ⌄ ]
//                └─ New part
//                   New module
//
// The open menu is closed by a full-screen invisible backdrop rather than
// a document listener, so there is no click-race that could swallow the
// very click that opened it.
// =====================================================================

import { createSignal, For, Show } from "solid-js"
import { ChevronDown } from "../icons"

export interface SplitButtonAction {
  readonly label: string
  readonly onSelect: () => void
}

export function SplitButton(props: {
  /** The default action: its label shows on the main button. */
  primary: SplitButtonAction
  /** The full menu, revealed by the chevron. */
  actions: readonly SplitButtonAction[]
}) {
  const [open, setOpen] = createSignal(false)

  return (
    <div class="split-button">
      <button class="hud-button split-primary" onClick={() => props.primary.onSelect()}>
        {props.primary.label}
      </button>
      <button
        class="hud-button split-toggle"
        aria-label="More options"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <ChevronDown size={14} />
      </button>

      <Show when={open()}>
        {/* Invisible catch-all: any click outside the menu closes it. */}
        <div class="split-backdrop" onClick={() => setOpen(false)} />
        <div class="hud-menu split-menu">
          <For each={props.actions}>
            {(action) => (
              <button
                class="hud-menu-item"
                onClick={() => {
                  setOpen(false)
                  action.onSelect()
                }}
              >
                {action.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
