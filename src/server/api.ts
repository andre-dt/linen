// =====================================================================
// src/server/api.ts — THE SERVER.
//
// Holds the kernel, the feature tree and the git store. Stateful but
// RECOVERABLE: nothing of value lives only in memory. If a session
// expires, its kernel state is dropped and reopening replays from the
// last commit.
//
// THREADING
// ---------
// Kernel operations are heavy — seconds, in bad cases — and they block.
// None of them may run on the event loop thread; every call is an async
// task on the libuv pool.
//
// OCCT is not thread-safe across operations on the same shape, so one
// session means one mutex: commands within a session serialize, while
// separate sessions run in parallel. Size UV_THREADPOOL_SIZE by expected
// concurrent sessions per instance.
// =====================================================================

import type { BodyId, KernelAdapter, KernelSession } from "../common/kernel"
import type { Command } from "../common/api"
import type { Container } from "../container/api"
import type {
  SessionId, SessionInfo, TreeDelta, CommandFailure, Diagnostic,
} from "../protocol/api"

// =====================================================================
// 1. SESSIONS
// =====================================================================

export interface SessionStore {
  open(project: string, branch: string): Promise<Session>
  get(id: SessionId): Session | null
  /** Every command resets the countdown. */
  touch(id: SessionId): void
  close(id: SessionId): Promise<void>
  /**
   * Drops expired sessions and releases their native memory.
   *
   * That release is explicit and must stay so: the JavaScript collector
   * never sees native allocations, and OCCT holds a great deal of them.
   */
  sweep(): Promise<readonly SessionId[]>
}

export interface Session {
  readonly info: SessionInfo
  readonly container: Container
  readonly kernel: KernelSession
  readonly tree: FeatureTree
  readonly meshCache: MeshCache
  /** Serializes commands within this session. */
  readonly queue: CommandQueue
  dispose(): Promise<void>
}

// =====================================================================
// 2. FEATURE TREE
// =====================================================================
// The tree IS the model. There is no separate "current state": the state
// is what you get by replaying the tree.

export interface FeatureTree {
  readonly features: readonly TreeNode[]
  /** Everything after this index is inactive. */
  readonly rollbackIndex: number

  append(command: Command<unknown, unknown>): Promise<RegenerationResult>
  update(feature: string, command: Command<unknown, unknown>): Promise<RegenerationResult>
  remove(feature: string): Promise<RegenerationResult>
  /** Rejected if it would place a feature before something it depends on. */
  reorder(feature: string, toIndex: number): Promise<RegenerationResult>
  suppress(feature: string, suppressed: boolean): Promise<RegenerationResult>
  rollbackTo(index: number): Promise<RegenerationResult>
  setVariable(name: string, expression: unknown): Promise<RegenerationResult>
}

export interface TreeNode {
  readonly id: string // stable forever; never reused
  readonly command: Command<unknown, unknown>
  readonly label: string
  readonly suppressed: boolean
  readonly bodies: readonly BodyId[]
  readonly status: "ok" | "warning" | "error" | "suppressed"
}

// =====================================================================
// 3. REGENERATION
// =====================================================================
// A dependency GRAPH, not a linear order. Changing feature three in a
// fifty-feature tree re-runs only what depends on it.
//
//   dirty = {changed} union {dependents, transitively}
//
// Dependencies come from three places:
//
//   1. an explicit Reference in the input
//   2. a selector resolving to another feature's geometry
//   3. an expression naming a changed variable
//
// The third is why expressions are syntax trees rather than numbers:
// without the tree there is no way to know feature seven depends on
// `wallThickness`.

export interface RegenerationResult {
  readonly commit: string
  readonly rebuilt: readonly string[]
  readonly reused: readonly string[]
  readonly failures: readonly CommandFailure[]
  readonly diagnostics: readonly Diagnostic[]
  readonly delta: TreeDelta
  readonly elapsedMilliseconds: number
}

export interface DependencyGraph {
  dependentsOf(feature: string): ReadonlySet<string>
  dependenciesOf(feature: string): ReadonlySet<string>
  /** Features to re-run, in execution order. */
  dirtyFrom(changed: readonly string[]): readonly string[]
  /** Rejects a reorder that would break an existing dependency. */
  canMove(feature: string, toIndex: number): boolean
}

// =====================================================================
// 4. COMMAND QUEUE
// =====================================================================
// One mutex per session. A preview arriving while an apply is running
// waits; a preview superseded by a newer one is dropped before it ever
// reaches the kernel.

export interface CommandQueue {
  /** Queued and awaited. */
  apply(command: Command<unknown, unknown>): Promise<RegenerationResult>
  /** Throwaway: coarse tolerance, never enters the tree or git.
   *  Supersedes any pending preview. */
  preview(command: Command<unknown, unknown>): Promise<PreviewResult>
  cancel(request: number): void
  readonly pending: number
}

export interface PreviewResult {
  readonly generation: number
  readonly mesh: ArrayBuffer | null
  readonly failure: CommandFailure | null
}

// =====================================================================
// 5. MESH CACHE
// =====================================================================
// Tessellation is expensive and its output is large. Cached per body and
// tolerance, invalidated when the body is rebuilt.

export interface MeshCache {
  get(body: BodyId, tolerance: number): ArrayBuffer | null
  set(body: BodyId, tolerance: number, mesh: ArrayBuffer): void
  invalidate(bodies: readonly BodyId[]): void
  readonly bytes: number
  /** Evicts least-recently-used entries down to the budget. */
  trim(budgetBytes: number): void
}

// =====================================================================
// 6. GIT STORE
// =====================================================================
// One repository per project. The tree is the content, commits are
// versions, branches are workspaces. Multi-version concurrency comes
// free.

export interface GitStore {
  load(project: string, branch: string): Promise<StoredProject>
  /** One commit per command. The UI may squash later. */
  commit(project: string, branch: string, tree: unknown, message: string): Promise<string>
  /** An annotated tag: IMMUTABLE by construction, which is what makes
   *  cross-project references safe. */
  seal(project: string, branch: string, name: string, description: string): Promise<string>
  branch(project: string, from: string, name: string): Promise<void>
  /** Feature-level, not textual: the payoff of using a feature tree as
   *  the storage format. */
  diff(project: string, first: string, second: string): Promise<unknown>
  history(project: string, branch: string): Promise<readonly StoredVersion[]>
}

export interface StoredProject {
  readonly tree: unknown
  readonly variables: unknown
  readonly commit: string
}

export interface StoredVersion {
  readonly commit: string
  readonly name: string | null // set when sealed
  readonly message: string
  readonly author: string
  readonly timestamp: string // ISO 8601
  readonly sealed: boolean
}

// =====================================================================
// 7. THE SERVER
// =====================================================================

export interface ServerOptions {
  readonly port: number
  readonly adapter: KernelAdapter
  readonly store: GitStore
  /** Seconds of inactivity before a session is dropped. */
  readonly sessionTimeToLive: number
  readonly meshCacheBudgetBytes: number
  /** Tessellation tolerance for previews. Coarser than the committed
   *  one: a preview that lags is worse than a preview that is rough. */
  readonly previewTolerance: number
  readonly commitTolerance: number
}

export interface Server {
  readonly sessions: SessionStore
  listen(): Promise<void>
  close(): Promise<void>
}

export type CreateServer = (options: ServerOptions) => Server
export declare const createServer: CreateServer
