// =====================================================================
// store/api.ts — THE DATABASE, as the app sees it.
//
// Accounts own projects; projects hold parts (and modules); a part is a
// history of parametric operations. All of it lives in git, through the
// one StorageBackend contract — local on disk today, git-over-S3 in
// production, chosen by which backend is passed in.
//
//   Store(backend, auth)
//     .signIn(credential)      -> Account            (creates on first sub)
//       account.projects()
//       account.createProject(name)
//         project.parts()
//         project.createPart(name)
//           part.apply(operation)      one API call = one commit
//           part.history() / rewindTo / overwrite
//           part.seal / branch / merge / diff
//
// Ownership is enforced here: every project/part handle carries the
// account it was opened for, and a mismatch is refused before the
// backend is touched.
// =====================================================================

import type {
  StorageBackend, Author, CommitId, Version, MergeResult, FileChange,
} from "./backend/api"
import type { AuthProvider, Identity } from "@linen/auth"

// --- persisted records (one file each in the project repo) ------------

/** accounts/<provider>.<subject>.json, in every project the account owns.
 *  The account index is the union of these across repositories. */
export interface AccountRecord {
  readonly id: string // `${provider}:${subject}`
  readonly provider: string
  readonly subject: string
  readonly email: string
  readonly name: string
  readonly picture: string | null
  readonly createdAt: string
}

/** projects/<id>.json — one per repository (the repo IS the project). */
export interface ProjectRecord {
  readonly id: string
  readonly ownerAccountId: string
  readonly name: string
  readonly createdAt: string
  /** Archived projects are hidden from the default list but never
   *  deleted — the git history is kept. `| null` (not `?`) so older
   *  records deserialize to a decided value. */
  readonly isArchived: boolean | null
}

/** parts/<id>.json — the part's metadata; the parametric history is the
 *  commit history of this file's tree, not a field. */
export interface PartRecord {
  readonly id: string
  readonly name: string
  readonly createdAt: string
  /** The feature tree: the ordered parametric operations. Opaque here;
   *  @linen/cad owns its shape. Replaced wholesale on every apply, with
   *  git keeping every prior state. */
  readonly operations: readonly unknown[]
}

// --- handles ----------------------------------------------------------

export interface Account {
  readonly record: AccountRecord
  projects(): Promise<readonly ProjectRecord[]>
  createProject(name: string): Promise<Project>
  openProject(id: string): Promise<Project>
}

export interface Project {
  readonly record: ProjectRecord
  parts(branch?: string): Promise<readonly PartRecord[]>
  createPart(name: string): Promise<Part>
  openPart(id: string, branch?: string): Promise<Part>
  // branch-level operations live on the project's repository
  branches(): Promise<readonly string[]>
  createBranch(name: string, from?: string): Promise<void>
  merge(source: string, into?: string): Promise<MergeResult>
  /** Marks the project archived (isArchived = true) and commits it. The
   *  project and its git history stay; it is only hidden by default. */
  setArchived(archived: boolean): Promise<void>
}

export interface Part {
  readonly record: PartRecord
  readonly branch: string
  /** Appends one parametric operation and commits it. */
  apply(operation: unknown, message?: string): Promise<CommitId>
  /** The commit history of this part's project branch. */
  history(): Promise<readonly Version[]>
  /** Reads the part as it was at a commit (rewind, read-only). */
  at(commit: string): Promise<PartRecord | null>
  /** Rewinds the branch to a past commit, discarding operations after it
   *  (destructive: a new commit whose tree matches `commit`). */
  rewindTo(commit: string, message?: string): Promise<CommitId>
  /** Overwrites the operation list wholesale (edit-in-place of history's
   *  tip). */
  overwrite(operations: readonly unknown[], message?: string): Promise<CommitId>
  /** Seals the current state as an immutable version (annotated tag). */
  seal(name: string, description: string): Promise<CommitId>
  versions(): Promise<readonly string[]>
  /** Feature-level diff of this part between two refs. */
  diff(first: string, second: string): Promise<readonly FileChange[]>
}

export interface Store {
  /** Verifies a credential via the auth provider and resolves to an
   *  account, creating one the first time a subject is seen. */
  signIn(credential: string): Promise<Account>
  /** Re-reads an account from git by id, or null if it no longer exists.
   *  Used to re-validate a session on every request: the source of truth
   *  is the repository, not the in-memory session. */
  account(id: string): Promise<Account | null>
}

// =====================================================================
// IMPLEMENTATION
// =====================================================================

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n")
const parse = <T>(bytes: Uint8Array | null): T | null =>
  bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as T) : null

// One repository, everything in folders:
//   accounts/<provider>.<subject>.json
//   projects/<projectId>/project.json
//   projects/<projectId>/parts/<partId>.json
const accountPath = (id: string): string => `accounts/${id.replace(":", ".")}.json`
const projectDir = (id: string): string => `projects/${id}`
const projectPath = (id: string): string => `${projectDir(id)}/project.json`
const partsDir = (projectId: string): string => `${projectDir(projectId)}/parts`
const partPath = (projectId: string, partId: string): string => `${partsDir(projectId)}/${partId}.json`

const DEFAULT_BRANCH = "main"

export interface StoreOptions {
  readonly backend: StorageBackend
  readonly auth: AuthProvider
  /** Deterministic clock, injectable for tests. Returns ISO 8601. */
  readonly now: () => string
  /** Id generator, injectable for tests. */
  readonly newId: () => string
}

export const createStore = (options: StoreOptions): Store => {
  const { backend, auth, now, newId } = options
  const authorOf = (record: AccountRecord): Author => ({ name: record.name, email: record.email })

  // The single repository must exist before anything reads or writes.
  // initialize() is idempotent, so calling it on the first operation is
  // cheap and keeps setup out of the caller's hands.
  let ready: Promise<void> | null = null
  const ensureRepo = (): Promise<void> => {
    if (!ready) ready = backend.initialize({ name: "linen", email: "system@linen" }, now())
    return ready
  }

  const loadAccount = async (id: string): Promise<AccountRecord | null> => {
    await ensureRepo()
    return parse<AccountRecord>(await backend.readFile(DEFAULT_BRANCH, accountPath(id)))
  }

  const makeAccount = (record: AccountRecord): Account => ({
    record,

    async projects() {
      await ensureRepo()
      // Every projects/<id>/ subtree whose project.json this account owns.
      const entries = await backend.listFiles(DEFAULT_BRANCH, "projects")
      const owned: ProjectRecord[] = []
      for (const entry of entries) {
        if (!entry.endsWith("/")) continue
        const id = entry.slice(0, -1)
        const project = parse<ProjectRecord>(await backend.readFile(DEFAULT_BRANCH, projectPath(id)))
        // Archived projects are hidden from the default list.
        if (project && project.ownerAccountId === record.id && !project.isArchived) owned.push(project)
      }
      return owned
    },

    async createProject(name) {
      await ensureRepo()
      const id = newId()
      const project: ProjectRecord = { id, ownerAccountId: record.id, name, createdAt: now(), isArchived: false }
      await backend.commit(
        DEFAULT_BRANCH,
        { writes: [{ path: projectPath(id), content: json(project) }], remove: [] },
        `create project ${name}`,
        authorOf(record),
        now(),
      )
      return makeProject(record, project)
    },

    async openProject(id) {
      await ensureRepo()
      const project = parse<ProjectRecord>(await backend.readFile(DEFAULT_BRANCH, projectPath(id)))
      if (!project) throw new Error(`project not found: ${id}`)
      if (project.ownerAccountId !== record.id) throw new Error(`account ${record.id} does not own project ${id}`)
      return makeProject(record, project)
    },
  })

  const makeProject = (account: AccountRecord, project: ProjectRecord): Project => {
    const author = authorOf(account)

    const readParts = async (branch: string): Promise<PartRecord[]> => {
      const files = await backend.listFiles(branch, partsDir(project.id))
      const records: PartRecord[] = []
      for (const file of files) {
        if (file.endsWith("/")) continue
        const record = parse<PartRecord>(await backend.readFile(branch, `${partsDir(project.id)}/${file}`))
        if (record) records.push(record)
      }
      return records
    }

    return {
      record: project,

      async parts(branch = DEFAULT_BRANCH) {
        return readParts(branch)
      },

      async createPart(name) {
        const id = newId()
        const part: PartRecord = { id, name, createdAt: now(), operations: [] }
        await backend.commit(
          DEFAULT_BRANCH,
          { writes: [{ path: partPath(project.id, id), content: json(part) }], remove: [] },
          `create part ${name}`,
          author,
          now(),
        )
        return makePart(account, project, part, DEFAULT_BRANCH)
      },

      async openPart(id, branch = DEFAULT_BRANCH) {
        const part = parse<PartRecord>(await backend.readFile(branch, partPath(project.id, id)))
        if (!part) throw new Error(`part not found: ${id}`)
        return makePart(account, project, part, branch)
      },

      // Branches and tags are repo-wide, plain git — not scoped per project.
      async branches() {
        return backend.listBranches()
      },

      async createBranch(name, from = DEFAULT_BRANCH) {
        await backend.createBranch(name, from)
      },

      async merge(source, into = DEFAULT_BRANCH) {
        return backend.merge(into, source, author, now())
      },

      async setArchived(archived) {
        const next: ProjectRecord = { ...project, isArchived: archived }
        await backend.commit(
          DEFAULT_BRANCH,
          { writes: [{ path: projectPath(project.id), content: json(next) }], remove: [] },
          `${archived ? "archive" : "unarchive"} project ${project.name}`,
          author,
          now(),
        )
        ;(project as { isArchived: boolean | null }).isArchived = archived
      },
    }
  }

  const makePart = (account: AccountRecord, project: ProjectRecord, part: PartRecord, branch: string): Part => {
    const author = authorOf(account)
    const path = partPath(project.id, part.id)
    const write = async (record: PartRecord, message: string): Promise<CommitId> =>
      backend.commit(
        branch,
        { writes: [{ path, content: json(record) }], remove: [] },
        message,
        author,
        now(),
      )

    return {
      record: part,
      branch,

      async apply(operation, message = "apply operation") {
        const next: PartRecord = { ...part, operations: [...part.operations, operation] }
        const commit = await write(next, message)
        ;(part as { operations: readonly unknown[] }).operations = next.operations
        return commit
      },

      // History filtered to this part's file: the commits that touched it,
      // even though the repository holds every other part too.
      async history() {
        return backend.history(branch, path)
      },

      async at(commit) {
        return parse<PartRecord>(await backend.readFile(commit, path))
      },

      async rewindTo(commit, message = "rewind history") {
        const past = await this.at(commit)
        if (!past) throw new Error(`part ${part.id} absent at ${commit}`)
        const restored: PartRecord = { ...part, operations: past.operations }
        const result = await write(restored, message)
        ;(part as { operations: readonly unknown[] }).operations = restored.operations
        return result
      },

      async overwrite(operations, message = "overwrite history") {
        const next: PartRecord = { ...part, operations }
        const result = await write(next, message)
        ;(part as { operations: readonly unknown[] }).operations = operations
        return result
      },

      async seal(name, description) {
        return backend.tag(branch, name, description, author, now())
      },

      async versions() {
        return backend.listTags()
      },

      async diff(first, second) {
        return backend.diff(first, second)
      },
    }
  }

  return {
    async account(id) {
      const record = await loadAccount(id)
      return record ? makeAccount(record) : null
    },

    async signIn(credential) {
      const result = await auth.verify(credential)
      if (!result.ok) throw new Error(`authentication failed: ${result.reason}`)
      const identity: Identity = result.identity
      const id = `${identity.provider}:${identity.subject}`
      const existing = await loadAccount(id)
      if (existing) return makeAccount(existing)

      const record: AccountRecord = {
        id,
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email,
        name: identity.name,
        picture: identity.picture,
        createdAt: now(),
      }
      await backend.commit(
        DEFAULT_BRANCH,
        { writes: [{ path: accountPath(id), content: json(record) }], remove: [] },
        `create account ${identity.email}`,
        { name: record.name, email: record.email },
        now(),
      )
      return makeAccount(record)
    },
  }
}
