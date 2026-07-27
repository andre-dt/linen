// =====================================================================
// apps/web/elements.ts — THE PART OUTLINE, client side.
//
// A part is a history of parametric operations. Each entry here is one
// such operation: which command produced it, the panel state that is
// still being filled in, and the input once it has been built.
//
// WHERE THIS LIVES, AND WHY NOT GIT YET
// -------------------------------------
// CLAUDE.md is clear that git is the database and every command is a
// commit. The server has no `part.apply` endpoint yet (projects.ts
// wraps /projects only), so this store is IN MEMORY, scoped to the open
// screen. It is deliberately shaped like the eventual API — an async
// list/append/update over a partId — so landing persistence replaces the
// three functions at the bottom and nothing above them.
//
// Nothing here fabricates history: an element exists only because the
// user created it in this session.
// =====================================================================

import { createSignal } from "solid-js"
import type { CommandDefinition, PanelState } from "@linen/cad/features"
import { beginCommand } from "@linen/cad/features"

// =====================================================================
// 1. THE ELEMENT
// =====================================================================

export interface PartElement {
  /** Stable within the session; becomes the feature id once persisted. */
  readonly id: string
  /** The command that produced it — "draft", "extrude". */
  readonly command: string
  /** The command's permanent uuid, so the designer can be reopened by
   *  URL without depending on the label or the id. */
  readonly uuid: string
  readonly label: string
  readonly icon: string
  /** The in-flight panel: which step, which values. This IS the
   *  element's definition while it is being authored. */
  readonly panel: PanelState
  /** "editing" until the user finishes the command; "built" once its
   *  input is complete. Never "ok"/"error" — that is the kernel's
   *  verdict, and there is no kernel yet to give one. */
  readonly status: "editing" | "built"
}

// =====================================================================
// 2. THE STORE
// =====================================================================
// One signal per part, created on first use. Keyed by partId so
// switching between parts in the same screen does not bleed elements
// from one into the other.

type Store = {
  readonly elements: () => readonly PartElement[]
  readonly setElements: (next: readonly PartElement[]) => void
}

const stores = new Map<string, Store>()

const storeFor = (partId: string): Store => {
  const existing = stores.get(partId)
  if (existing) return existing
  const [elements, setElements] = createSignal<readonly PartElement[]>([])
  const created: Store = { elements, setElements: (next) => setElements(next) }
  stores.set(partId, created)
  return created
}

export const elementsOf = (partId: string): readonly PartElement[] =>
  storeFor(partId).elements()

/**
 * Appends a new element for a command and opens it at its first step.
 * This is what clicking "Draft" in the toolbar does: the part gains an
 * entry, and that entry's designer is what the input HUD then renders.
 */
export const appendElement = (
  partId: string,
  command: CommandDefinition<never, never>,
): PartElement => {
  const store = storeFor(partId)
  const current = store.elements()
  const element: PartElement = {
    id: nextId(command.id, current),
    command: command.id,
    uuid: command.uuid,
    label: labelFor(command, current),
    icon: command.icon,
    panel: beginCommand(command),
    status: "editing",
  }
  store.setElements([...current, element])
  return element
}

export const updateElement = (
  partId: string,
  elementId: string,
  change: (element: PartElement) => PartElement,
): void => {
  const store = storeFor(partId)
  store.setElements(
    store.elements().map((element) => (element.id === elementId ? change(element) : element)),
  )
}

export const removeElement = (partId: string, elementId: string): void => {
  const store = storeFor(partId)
  store.setElements(store.elements().filter((element) => element.id !== elementId))
}

// =====================================================================
// 3. NAMING
// =====================================================================
// "Draft 1", "Draft 2" — the ordinal counts elements of the SAME command
// already present, so deleting Draft 1 does not renumber Draft 2 into
// its place. Matching how every CAD names history entries.

const nextId = (command: string, existing: readonly PartElement[]): string => {
  let ordinal = existing.length + 1
  const taken = new Set(existing.map((element) => element.id))
  while (taken.has(`${command}-${ordinal}`)) ordinal += 1
  return `${command}-${ordinal}`
}

const labelFor = (
  command: CommandDefinition<never, never>,
  existing: readonly PartElement[],
): string => {
  const sameCommand = existing.filter((element) => element.command === command.id)
  return `${command.label} ${sameCommand.length + 1}`
}
