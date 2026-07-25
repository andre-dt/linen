// =====================================================================
// apps/web/widgets/drawer.tsx — a full-height panel flush to the right.
//
// A reusable side surface: it slides in from the right edge and holds
// whatever the caller puts in it. It knows nothing about projects, parts,
// or any other content — a new-project form today, a part's history or a
// settings pane tomorrow, all through the same component.
//
// Two ways to use it:
//   - Pass `onSave` (and `canSave`) to get the built-in form footer with
//     Cancel / Save, and children submit on Enter.
//   - Omit `onSave` to get a plain scrollable body with no footer, for
//     read-only or self-managed content.
// =====================================================================

import { Show, type JSX } from "solid-js"

export function Drawer(props: {
  open: boolean
  title: string
  onClose: () => void
  children: JSX.Element
  /** When present, renders the Cancel / Save footer and wraps children in
   *  a form that submits on Enter. Omit for footer-less content. */
  onSave?: () => void
  /** Enables Save; ignored when `onSave` is absent. Defaults to true. */
  canSave?: boolean
  /** Save button label; defaults to "Save". */
  saveLabel?: string
}) {
  const hasFooter = (): boolean => props.onSave !== undefined
  const canSave = (): boolean => props.canSave ?? true

  const body = (
    <>
      {props.children}
      <Show when={hasFooter()}>
        <div class="drawer-actions">
          <button type="button" class="hud-button subtle" onClick={props.onClose}>Cancel</button>
          <button type="submit" class="hud-button primary" disabled={!canSave()}>
            {props.saveLabel ?? "Save"}
          </button>
        </div>
      </Show>
    </>
  )

  return (
    <Show when={props.open}>
      {/* Transparent layer: an outside click cancels, but nothing dims. */}
      <div class="drawer-backdrop" onClick={props.onClose} />

      <aside class="drawer hud-panel" role="dialog" aria-label={props.title}>
        <header class="drawer-head">
          <h2>{props.title}</h2>
          <button class="hud-button subtle" onClick={props.onClose} aria-label="Close">✕</button>
        </header>

        <Show
          when={hasFooter()}
          fallback={<div class="drawer-body">{body}</div>}
        >
          <form
            class="drawer-body"
            onSubmit={(event) => {
              event.preventDefault()
              if (canSave()) props.onSave?.()
            }}
          >
            {body}
          </form>
        </Show>
      </aside>
    </Show>
  )
}
