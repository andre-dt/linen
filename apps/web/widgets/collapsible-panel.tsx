// =====================================================================
// apps/web/widgets/collapsible-panel.tsx — a HUD panel that collapses.
//
// Two states, same slot:
//   expanded  → a titled panel (title left, a minimize button right) with
//               the caller's content below.
//   collapsed → a single icon button: the panel's semantic icon, the
//               title as its tooltip. It occupies the same position, so
//               collapsing frees space without shifting the layout.
//
// The collapsed/expanded choice is remembered per `id` in localStorage,
// so a panel a user tucked away stays tucked away across reloads.
// =====================================================================

import { createSignal, Show, type JSX } from "solid-js"
import { LucideIcon } from "./lucide-icon"
import { CollapsedHudButton } from "./button"

const key = (id: string): string => `linen.hud-panel.${id}.collapsed`

// The stored choice wins; absent one, the caller's default decides. So a
// panel marked defaultCollapsed opens collapsed on first sight, yet a user
// who later expands it is remembered.
const readCollapsed = (id: string, fallback: boolean): boolean => {
  try {
    const stored = localStorage.getItem(key(id))
    if (stored === null) return fallback
    return stored === "1"
  } catch {
    return fallback
  }
}
const writeCollapsed = (id: string, collapsed: boolean): void => {
  try {
    localStorage.setItem(key(id), collapsed ? "1" : "0")
  } catch {
    // storage unavailable — the panel still works, just without memory
  }
}

export function CollapsiblePanel(props: {
  /** Stable id for persisting collapsed state. */
  id: string
  /** Shown as the header title and as the collapsed button's tooltip. */
  title: string
  /** Lucide icon name shown on the collapsed button. */
  icon: string
  /** Extra class on the expanded panel (per-panel width / height). */
  class?: string
  /** Header actions, left of the minimize button. */
  actions?: JSX.Element
  /** Collapsed state on first sight, before the user has toggled it.
   *  A stored choice always wins over this. Defaults to expanded. */
  defaultCollapsed?: boolean
  children: JSX.Element
}) {
  const [collapsed, setCollapsed] = createSignal(
    readCollapsed(props.id, props.defaultCollapsed ?? false),
  )
  const toggle = (): void => {
    const next = !collapsed()
    setCollapsed(next)
    writeCollapsed(props.id, next)
  }

  return (
    <Show
      when={!collapsed()}
      fallback={
        <CollapsedHudButton label={props.title} onClick={toggle}>
          <LucideIcon name={props.icon} size={18} />
        </CollapsedHudButton>
      }
    >
      <section class={`hud-panel hud-collapsible ${props.class ?? ""}`}>
        <header class="hud-list-head">
          <h2>{props.title}</h2>
          <div class="hud-head-actions">
            {props.actions}
            <button class="hud-icon-button" aria-label="Collapse panel" onClick={toggle}>
              <LucideIcon name="minimize-2" size={14} />
            </button>
          </div>
        </header>
        {props.children}
      </section>
    </Show>
  )
}
