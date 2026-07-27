// =====================================================================
// apps/web/src/session.ts — THE REACTIVE BRIDGE.
//
// Wraps the transport client in Solid signals so panels can render from
// it, while keeping the canvas out of the reactive graph entirely.
//
// WHAT IS REACTIVE AND WHAT IS NOT
// --------------------------------
//   reactive    the feature tree, variables, panel state, diagnostics
//               — all small, all rendered as DOM
//
//   imperative  meshes, GPU buffers, camera
//               — large, uploaded once, drawn every frame
//
// Mesh frames deliberately do NOT pass through a signal. They arrive on
// the binary channel and go straight to the scene: routing megabytes
// through the reactive graph would schedule DOM work for data no DOM
// node ever reads.
// =====================================================================

import { createSignal, onCleanup } from "solid-js"
import type {
  Client, ConnectionState, FeatureSummary, Diagnostic, SessionInfo,
} from "@linen/protocol"
import type { CommandDefinition, PanelState } from "@linen/cad/features"
import type { Scene } from "@linen/viewer"
import { standardPreset, beginCommand } from "@linen/cad/features"

export interface Session {
  // --- connection -----------------------------------------------------
  readonly info: () => SessionInfo | null
  readonly connection: () => ConnectionState

  // --- model ----------------------------------------------------------
  readonly tree: () => readonly FeatureSummary[]
  readonly diagnostics: () => readonly Diagnostic[]
  readonly regenerationMilliseconds: () => number | null

  // --- in-flight command ----------------------------------------------
  readonly panel: () => PanelState | null
  readonly definitions: () => readonly CommandDefinition<never, never>[]
  beginCommand(definition: CommandDefinition<never, never>): void
  cancelCommand(): void

  // --- the imperative side --------------------------------------------
  /**
   * Set once the canvas exists. Not a signal: panels never re-render
   * because the scene changed, and the scene never re-renders because a
   * panel did.
   */
  scene: Scene | null
  readonly client: Client | null
}

export function useSession(): Session {
  const [info, setInfo] = createSignal<SessionInfo | null>(null)
  const [connection, setConnection] = createSignal<ConnectionState>({ kind: "connecting" })
  const [tree, setTree] = createSignal<readonly FeatureSummary[]>([])
  const [diagnostics, setDiagnostics] = createSignal<readonly Diagnostic[]>([])
  const [elapsed, setElapsed] = createSignal<number | null>(null)
  const [panel, setPanel] = createSignal<PanelState | null>(null)
  // Every command from every registered feature. Derived from the
  // preset rather than listed by hand: adding a feature must not
  // require touching the UI.
  const [definitions] = createSignal<readonly CommandDefinition<never, never>[]>(
    standardPreset.flatMap((feature) => feature.commands),
  )

  const session: Session = {
    info,
    connection,
    tree,
    diagnostics,
    regenerationMilliseconds: elapsed,
    panel,
    definitions,
    scene: null,
    client: null,

    beginCommand(definition) {
      // The machine lives in @linen/cad, so opening a command here and
      // opening one from the outline mean exactly the same thing.
      setPanel(beginCommand(definition))
    },

    cancelCommand() {
      setPanel(null)
      // Clearing the preview is imperative: it is geometry, not state.
      session.scene?.clear()
    },
  }

  onCleanup(() => {
    session.client?.["close" as never]
  })

  return session
}
