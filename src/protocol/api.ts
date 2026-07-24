// =====================================================================
// src/protocol/api.ts — CLIENT/SERVER CONTRACT.
//
// Two channels over one WebSocket, because the payloads are nothing
// alike:
//
//   JSON    commands, tree deltas, diagnostics      small, readable
//   BINARY  meshes                                  large, GPU-bound
//
// Meshes must NEVER be JSON-encoded. The layout in common/kernel.ts
// exists so the same bytes travel native -> socket -> GPU buffer
// untouched; base64 inside a JSON envelope would inflate them by a third
// and force a copy on both ends.
//
// THE COMMAND IS DATA
// -------------------
// There is no method-per-feature on the wire. The client sends the same
// `Command` value that goes into the feature tree and into git — one
// envelope type for every feature, present and future. A new feature
// adds no protocol surface at all.
// =====================================================================

import type { BodyId, EntityId } from "../common/kernel"
import type { Command, FeatureName } from "../common/api"

// =====================================================================
// 1. SESSION
// =====================================================================
// The server is stateful but RECOVERABLE: nothing of value lives only in
// memory. If a session expires its kernel state is discarded, and
// reopening replays from the last git commit.

export type SessionId = string & { readonly __brand: "session" }

export interface SessionInfo {
  readonly session: SessionId
  readonly project: string
  readonly branch: string
  /** Seconds of inactivity before the kernel state is dropped. Every
   *  command resets it. */
  readonly timeToLive: number
  readonly kernel: { readonly name: string; readonly version: string }
  /** Capabilities the connected kernel advertises. The client greys out
   *  toolbar entries whose requirements are unmet, instead of letting
   *  the user start a command that cannot finish. */
  readonly capabilities: readonly string[]
}

// =====================================================================
// 2. CLIENT TO SERVER
// =====================================================================

export type ClientMessage =
  | { readonly kind: "session.open"; readonly project: string; readonly branch: string }
  | { readonly kind: "session.close" }
  /** Appends a command to the tree and regenerates what it dirties. */
  | { readonly kind: "command.apply"; readonly request: RequestId; readonly command: Command<unknown, unknown> }
  /** Same input, but throwaway: coarse tolerance, never enters the tree,
   *  never reaches git. Drives hover previews. */
  | { readonly kind: "command.preview"; readonly request: RequestId; readonly command: Command<unknown, unknown> }
  | { readonly kind: "command.cancel"; readonly request: RequestId }
  /** Edits an existing feature in place. */
  | { readonly kind: "feature.update"; readonly request: RequestId; readonly feature: string; readonly command: Command<unknown, unknown> }
  | { readonly kind: "feature.suppress"; readonly feature: string; readonly suppressed: boolean }
  | { readonly kind: "feature.remove"; readonly feature: string }
  | { readonly kind: "feature.reorder"; readonly feature: string; readonly toIndex: number }
  /** Moves the rollback marker; everything after it goes inactive. */
  | { readonly kind: "history.rollback"; readonly toIndex: number }
  | { readonly kind: "variable.set"; readonly name: string; readonly expression: unknown }
  /** Seals the current state as an immutable version. */
  | { readonly kind: "version.seal"; readonly request: RequestId; readonly name: string; readonly description: string }
  /** Resolves a selector server-side so the client can highlight valid
   *  candidates before anything is committed. */
  | { readonly kind: "selector.resolve"; readonly request: RequestId; readonly selector: unknown }
  /** Re-tessellates at a finer tolerance, typically after zooming in. */
  | { readonly kind: "mesh.refine"; readonly body: BodyId; readonly tolerance: number }

export type RequestId = number

// =====================================================================
// 3. SERVER TO CLIENT
// =====================================================================

export type ServerMessage =
  | { readonly kind: "session.opened"; readonly info: SessionInfo }
  | { readonly kind: "session.expired"; readonly reason: "timeout" | "evicted" | "error" }
  /** Applied successfully. Meshes follow on the binary channel. */
  | { readonly kind: "command.applied"; readonly request: RequestId; readonly delta: TreeDelta }
  | { readonly kind: "command.failed"; readonly request: RequestId; readonly failure: CommandFailure }
  /** Progress for operations that take real time. */
  | { readonly kind: "command.progress"; readonly request: RequestId; readonly fraction: number; readonly stage: string }
  | { readonly kind: "selector.resolved"; readonly request: RequestId; readonly entities: readonly EntityId[] }
  | { readonly kind: "version.sealed"; readonly request: RequestId; readonly version: string }
  /** The tree changed without a request of ours: another client on the
   *  same branch, or a regeneration triggered elsewhere. */
  | { readonly kind: "tree.changed"; readonly delta: TreeDelta }

/**
 * What actually changed.
 *
 * The client applies this to its local mirror rather than refetching: a
 * fifty-feature part must not round-trip in full because one distance
 * moved.
 */
export interface TreeDelta {
  readonly commit: string // git sha
  readonly added: readonly FeatureSummary[]
  readonly updated: readonly FeatureSummary[]
  readonly removed: readonly string[]
  /** Bodies whose mesh follows on the binary channel. */
  readonly meshes: readonly BodyId[]
  /** Bodies that disappeared: drop their GPU buffers. */
  readonly discarded: readonly BodyId[]
  readonly diagnostics: readonly Diagnostic[]
}

export interface FeatureSummary {
  readonly id: string
  readonly name: FeatureName
  readonly label: string
  readonly index: number
  readonly suppressed: boolean
  readonly status: "ok" | "warning" | "error" | "suppressed"
  /** Bodies this feature produced; drives feature-tree highlighting. */
  readonly bodies: readonly BodyId[]
}

// =====================================================================
// 4. FAILURES
// =====================================================================
// A failing feature must not kill the model. The server reports what
// went wrong, what it did about it, and carries on.

export interface CommandFailure {
  readonly feature: string | null
  readonly code: FailureCode
  readonly message: string
  /** Entities involved: the client highlights them in the error colour. */
  readonly entities: readonly EntityId[]
  readonly recovery: "suppressed" | "used-last-good" | "halted"
}

export type FailureCode =
  | "selector.empty" // resolved to nothing
  | "selector.cardinality" // expected one, found several
  | "selector.ambiguous" // cannot disambiguate after a change
  | "expression.cycle"
  | "expression.undefined-variable"
  | "expression.dimension-mismatch"
  | "kernel.operation-failed"
  | "kernel.unsupported"
  | "validation.failed" // the pre-native check refused it
  | "session.expired"

export interface Diagnostic {
  readonly feature: string
  readonly severity: "error" | "warning" | "info"
  readonly code: FailureCode | "regeneration.slow"
  readonly message: string
}

// =====================================================================
// 5. BINARY CHANNEL
// =====================================================================
// Every binary frame carries a small header identifying its body, then
// the mesh buffer verbatim. The client slices past the header and hands
// the rest to the codec — still no copy.
//
//   u32 magic ("LNMH")
//   u32 bodyId
//   u32 generation   discards frames superseded while in flight
//   u32 flags        bit 0: preview, bit 1: refinement
//   ...mesh buffer, exactly as laid out in common/kernel.ts

export const MESH_FRAME_MAGIC = 0x4c4e4d48
export const MESH_FRAME_HEADER_BYTES = 16

export interface MeshFrameHeader {
  readonly body: BodyId
  readonly generation: number
  readonly preview: boolean
  readonly refinement: boolean
}

export type ReadMeshFrameHeader = (frame: ArrayBuffer) => MeshFrameHeader
/** Returns a view past the header. Does not copy. */
export type MeshFramePayload = (frame: ArrayBuffer) => ArrayBuffer

export declare const readMeshFrameHeader: ReadMeshFrameHeader
export declare const meshFramePayload: MeshFramePayload

// =====================================================================
// 6. TRANSPORT
// =====================================================================

export interface Transport {
  send(message: ClientMessage): void
  readonly onMessage: (handler: (message: ServerMessage) => void) => Unsubscribe
  readonly onMeshFrame: (handler: (frame: ArrayBuffer) => void) => Unsubscribe
  readonly onStateChange: (handler: (state: ConnectionState) => void) => Unsubscribe
  close(): void
}

export type Unsubscribe = () => void

export type ConnectionState =
  | { readonly kind: "connecting" }
  | { readonly kind: "open"; readonly session: SessionId }
  /** Reconnecting with backoff. Commands queue meanwhile. */
  | { readonly kind: "reconnecting"; readonly attempt: number }
  | { readonly kind: "closed"; readonly reason: string }

export type ConnectTransport = (
  url: string,
  project: string,
  branch: string,
) => Promise<Transport>
export declare const connectTransport: ConnectTransport

// =====================================================================
// 7. CLIENT
// =====================================================================
// Ties transport, viewer and panel together. Owns the local mirror of
// the tree; the viewer owns GPU state; the panel owns in-progress input.

export interface Client {
  readonly session: SessionInfo
  readonly connection: ConnectionState
  readonly tree: readonly FeatureSummary[]

  apply(command: Command<unknown, unknown>): Promise<CommandOutcome>
  /** Fire and forget: superseded previews are dropped by generation. */
  preview(command: Command<unknown, unknown>): void
  clearPreview(): void

  update(feature: string, command: Command<unknown, unknown>): Promise<CommandOutcome>
  suppress(feature: string, suppressed: boolean): Promise<void>
  remove(feature: string): Promise<void>
  rollbackTo(index: number): Promise<void>

  setVariable(name: string, expression: unknown): Promise<CommandOutcome>
  seal(name: string, description: string): Promise<string>

  /** Highlights valid candidates for the active panel field. */
  resolveSelector(selector: unknown): Promise<readonly EntityId[]>
}

export type CommandOutcome =
  | { readonly ok: true; readonly delta: TreeDelta }
  | { readonly ok: false; readonly failure: CommandFailure }
