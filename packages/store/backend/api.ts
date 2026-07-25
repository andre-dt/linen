// =====================================================================
// store/backend/api.ts — THE ONE STORAGE CONTRACT.
//
// The database is git. This is the narrow surface every backend
// implements: the denominator comum between "git on local disk" (dev,
// self-host) and "git-over-S3, serverless" (production, to build).
//
// Nothing above this file imports isomorphic-git, libgit or an S3 SDK.
// The domain layer (accounts, projects, parts) talks only to these
// types, so swapping the backend is configuration — mirroring the same
// discipline as the pluggable geometry kernel.
//
// Scope: ONE repository per project. Accounts are an index above the
// repositories; parts and modules are files inside a project's repo.
// =====================================================================

/** A git object id (40-hex sha). Opaque above this layer. */
export type CommitId = string & { readonly __brand: "commit" }

/** Who authored a change. Comes from the AuthProvider identity, so
 *  `git log` shows the real person behind each parametric operation. */
export interface Author {
  readonly name: string
  readonly email: string
}

/** A file written in a single commit. `content` is the serialized bytes;
 *  the domain layer decides the JSON. `path` is repo-relative POSIX. */
export interface FileWrite {
  readonly path: string
  readonly content: Uint8Array
}

/** One entry of a project's history — a commit on a branch. */
export interface Version {
  readonly commit: CommitId
  readonly message: string
  readonly author: Author
  /** ISO 8601. Supplied by the caller, never read from a wall clock in
   *  the backend, so replays stay deterministic. */
  readonly timestamp: string
  /** The sealed name, when this commit carries an annotated tag. */
  readonly tag: string | null
}

// =====================================================================
// THE BACKEND
// =====================================================================
// ONE repository holds everything. Accounts, every project and every part
// are folders and files inside it (accounts/, projects/<id>/…). There is
// no per-project repo: branch and tag are ordinary, repo-wide git refs,
// exactly as a standard git repository behaves.
//
// A backend maps this single repo to a location however it likes: a
// directory at ../linen-data locally, an S3 key prefix in production. The
// caller never sees the difference.

export interface StorageBackend {
  // --- repository lifecycle ------------------------------------------
  /** Creates the repository with an empty initial commit on `main`, if it
   *  does not already exist. Idempotent. */
  initialize(author: Author, timestamp: string): Promise<void>

  // --- reading --------------------------------------------------------
  /** The file at `path` on `ref` (a branch, tag or commit), or null if
   *  absent. */
  readFile(ref: string, path: string): Promise<Uint8Array | null>
  /** POSIX paths under `directory` (non-recursive) on `ref`. Directory
   *  entries end with "/". */
  listFiles(ref: string, directory: string): Promise<readonly string[]>

  // --- writing --------------------------------------------------------
  /** Stages `writes` (and deletes `remove`) on top of `branch`, then
   *  commits. One commit per parametric operation. Returns the new sha. */
  commit(
    branch: string,
    changes: { readonly writes: readonly FileWrite[]; readonly remove: readonly string[] },
    message: string,
    author: Author,
    timestamp: string,
  ): Promise<CommitId>

  // --- history & versioning ------------------------------------------
  /** Commit history of `ref`. `path`, when given, limits it to commits
   *  that touched that path — the history of one part or project. */
  history(ref: string, path?: string): Promise<readonly Version[]>
  resolveRef(ref: string): Promise<CommitId | null>
  /** An annotated tag: immutable by construction. Rejects if the name
   *  already exists. */
  tag(ref: string, name: string, message: string, author: Author, timestamp: string): Promise<CommitId>
  listTags(): Promise<readonly string[]>

  // --- branching & merge ---------------------------------------------
  createBranch(name: string, fromRef: string): Promise<void>
  listBranches(): Promise<readonly string[]>
  /** Merges `source` into `target`. On a clean merge returns the commit;
   *  on conflict returns the conflicting paths for feature-level
   *  resolution above — never a textual merge marker in a file. */
  merge(target: string, source: string, author: Author, timestamp: string): Promise<MergeResult>

  // --- diff -----------------------------------------------------------
  /** Which files changed between two refs, with each side's bytes so the
   *  domain layer can diff feature trees rather than text. */
  diff(first: string, second: string): Promise<readonly FileChange[]>
}

export type MergeResult =
  | { readonly ok: true; readonly commit: CommitId }
  | { readonly ok: false; readonly conflicts: readonly string[] }

export interface FileChange {
  readonly path: string
  readonly status: "added" | "modified" | "removed"
  readonly before: Uint8Array | null
  readonly after: Uint8Array | null
}

/** Constructs a backend. The local one takes a root directory; the S3
 *  one will take a bucket/prefix — same shape, chosen by configuration. */
export type CreateBackend = (options: unknown) => StorageBackend
