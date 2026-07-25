// =====================================================================
// store/backend/local.ts — THE LOCAL GIT BACKEND (real git binary).
//
// ONE bare git repository at a fixed location (../linen-data in dev),
// driven through the actual `git` executable via child_process. Accounts,
// projects and parts are all folders inside it; branch and tag are
// ordinary repo-wide git refs. This is the canonical git — the same
// binary the world trusts — so merge, diff, tag and branch semantics are
// exactly right, with no native build to maintain outside the kernel.
//
// Commits are built with PLUMBING (hash-object, mktree via update-index,
// commit-tree, update-ref), never a working tree: the repo stays bare,
// every write is atomic, and nothing on disk can drift out of the object
// database.
//
// This is a permanent backend (dev, self-host), not a mock. The future
// git-over-S3 backend implements the same StorageBackend contract.
// =====================================================================

import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import type {
  StorageBackend, CommitId, Author, FileWrite, Version, MergeResult, FileChange,
} from "./api"

export interface LocalBackendOptions {
  /** The repository's working directory. `git init` runs here, so
   *  accounts/ and projects/ appear as real files on disk that you can
   *  `cd` into and `ls` — not just objects in a bare database. */
  readonly root: string
  /** Path to the git binary. Defaults to "git" on PATH. */
  readonly gitBinary?: string
}

interface RunOptions {
  readonly input?: Uint8Array
  readonly env?: Record<string, string>
  readonly allowFailure?: boolean
}

interface RunResult {
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: string
}

export const createLocalBackend = (options: LocalBackendOptions): StorageBackend => {
  const bin = options.gitBinary ?? "git"
  // A normal (non-bare) repository: the working tree is `root`, its git
  // dir is root/.git. Every command names both, so plumbing writes to the
  // object database and porcelain sees the checked-out files.
  const workTree = options.root
  const gitDir = `${options.root}/.git`
  const gitArgs = ["--git-dir", gitDir, "--work-tree", workTree]

  const run = (args: readonly string[], run: RunOptions = {}): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, [...gitArgs, ...args], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...run.env },
      })
      const out: Buffer[] = []
      let err = ""
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()))
      child.on("error", reject)
      child.on("close", (code) => {
        const result: RunResult = { code: code ?? 0, stdout: Buffer.concat(out), stderr: err }
        if (result.code !== 0 && !run.allowFailure) {
          reject(new Error(`git ${args.join(" ")} failed (${result.code}): ${err.trim()}`))
          return
        }
        resolve(result)
      })
      if (run.input) child.stdin.write(run.input)
      child.stdin.end()
    })

  const text = (result: RunResult): string => result.stdout.toString("utf8")

  const identityEnv = (author: Author, timestamp: string): Record<string, string> => {
    const date = `${Math.floor(Date.parse(timestamp) / 1000)} +0000`
    return {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: date,
    }
  }

  // Reads the tree at `ref` into a fresh temp index, applies writes and
  // removes, and writes a new tree object. A per-call GIT_INDEX_FILE keeps
  // concurrent commits from sharing an index.
  const buildTree = async (
    baseRef: string | null,
    writes: readonly FileWrite[],
    remove: readonly string[],
    env: Record<string, string>,
  ): Promise<string> => {
    const indexFile = `${gitDir}/index.tmp.${process.pid}.${indexCounter++}`
    const withIndex = { ...env, GIT_INDEX_FILE: indexFile }
    try {
      if (baseRef) {
        const treeish = text(await run(["rev-parse", `${baseRef}^{tree}`], { allowFailure: true })).trim()
        if (treeish) await run(["read-tree", treeish], { env: withIndex })
      }
      for (const write of writes) {
        const oid = text(
          await run(["hash-object", "-w", "--stdin"], { input: write.content, env: withIndex }),
        ).trim()
        await run(["update-index", "--add", "--cacheinfo", `100644,${oid},${write.path}`], { env: withIndex })
      }
      for (const path of remove) {
        await run(["update-index", "--force-remove", path], { env: withIndex, allowFailure: true })
      }
      return text(await run(["write-tree"], { env: withIndex })).trim()
    } finally {
      await fs.rm(indexFile, { force: true })
    }
  }

  const commitTree = async (
    tree: string,
    parents: readonly string[],
    message: string,
    env: Record<string, string>,
  ): Promise<string> => {
    const args = ["commit-tree", tree]
    for (const parent of parents) args.push("-p", parent)
    return text(await run(args, { input: new TextEncoder().encode(message), env })).trim()
  }

    // After moving `branch` to `oid`, bring the working tree into line so
    // the files on disk match the commit — only when that branch is the
    // one currently checked out (HEAD). Writes to other branches leave the
    // checkout untouched, exactly as git does.
  const syncWorkTree = async (branch: string): Promise<void> => {
    const head = text(await run(["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true })).trim()
    if (head !== branch) return
    await run(["reset", "--hard", branch], { allowFailure: true })
  }

  const backend: StorageBackend = {
    async initialize(author, timestamp) {
      try {
        await fs.access(`${gitDir}/HEAD`)
        return // already a repository
      } catch {
        // create it below
      }
      await fs.mkdir(workTree, { recursive: true })
      // A normal repo with a working tree, so the data is browsable on disk.
      await run(["init", "--initial-branch=main"])
      const env = identityEnv(author, timestamp)
      const tree = await buildTree(null, [], [], env)
      const oid = await commitTree(tree, [], "initialize linen data", env)
      await run(["update-ref", "refs/heads/main", oid])
      await run(["symbolic-ref", "HEAD", "refs/heads/main"], { allowFailure: true })
      await syncWorkTree("main")
    },

    async readFile(ref, path) {
      const result = await run(["cat-file", "blob", `${ref}:${path}`], { allowFailure: true })
      return result.code === 0 ? new Uint8Array(result.stdout) : null
    },

    async listFiles(ref, directory) {
      const spec = directory ? `${ref}:${directory}` : ref
      const result = await run(["ls-tree", "--name-only", spec], { allowFailure: true })
      if (result.code !== 0) return []
      // ls-tree names are bare; append "/" to directories so the caller can
      // tell projects/<id>/ subtrees from files.
      const detailed = await run(["ls-tree", spec], { allowFailure: true })
      const dirs = new Set(
        text(detailed)
          .split("\n")
          .filter((line) => line.includes(" tree "))
          .map((line) => line.split("\t")[1]?.trim())
          .filter((name): name is string => Boolean(name)),
      )
      return text(result)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((name) => (dirs.has(name) ? `${name}/` : name))
    },

    async commit(branch, changes, message, author, timestamp) {
      const env = identityEnv(author, timestamp)
      const parent = text(await run(["rev-parse", branch])).trim()
      const tree = await buildTree(branch, changes.writes, changes.remove, env)
      const oid = await commitTree(tree, [parent], message, env)
      await run(["update-ref", `refs/heads/${branch}`, oid])
      await syncWorkTree(branch)
      return oid as CommitId
    },

    async history(ref, path) {
      const format = "%H%x1f%an%x1f%ae%x1f%aI%x1f%s"
      const args = ["log", `--format=${format}`, ref]
      if (path) args.push("--", path)
      const result = await run(args, { allowFailure: true })
      if (result.code !== 0) return []
      const tagByCommit = new Map<string, string>()
      for (const name of await backend.listTags()) {
        const target = await backend.resolveRef(name)
        if (target) tagByCommit.set(target, name)
      }
      return text(result)
        .split("\n")
        .filter(Boolean)
        .map<Version>((line) => {
          const [commit = "", name, email, date, subject] = line.split("\x1f")
          return {
            commit: commit as CommitId,
            message: subject ?? "",
            author: { name: name ?? "", email: email ?? "" },
            timestamp: date ?? "",
            tag: tagByCommit.get(commit) ?? null,
          }
        })
    },

    async resolveRef(ref) {
      const result = await run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true })
      const oid = text(result).trim()
      return oid ? (oid as CommitId) : null
    },

    async tag(ref, name, message, author, timestamp) {
      const env = identityEnv(author, timestamp)
      const target = text(await run(["rev-parse", ref])).trim()
      await run(["tag", "-a", name, "-m", message, target], { env })
      return target as CommitId
    },

    async listTags() {
      const result = await run(["tag", "--list"], { allowFailure: true })
      return result.code === 0 ? text(result).split("\n").map((line) => line.trim()).filter(Boolean) : []
    },

    async createBranch(name, fromRef) {
      const oid = text(await run(["rev-parse", fromRef])).trim()
      await run(["update-ref", `refs/heads/${name}`, oid])
    },

    async listBranches() {
      const result = await run(["branch", "--list", "--format=%(refname:short)"], { allowFailure: true })
      return result.code === 0 ? text(result).split("\n").map((line) => line.trim()).filter(Boolean) : []
    },

    async merge(target, source, author, timestamp) {
      const env = identityEnv(author, timestamp)
      const targetOid = text(await run(["rev-parse", target])).trim()
      const sourceOid = text(await run(["rev-parse", source])).trim()
      const baseOid = text(await run(["merge-base", targetOid, sourceOid], { allowFailure: true })).trim()

      if (baseOid === targetOid) {
        await run(["update-ref", `refs/heads/${target}`, sourceOid])
        await syncWorkTree(target)
        return { ok: true, commit: sourceOid as CommitId }
      }
      if (baseOid === sourceOid) return { ok: true, commit: targetOid as CommitId }

      // `merge-tree --write-tree` merges in the object database, no checkout.
      const merged = await run(
        ["merge-tree", "--write-tree", "--name-only", "-z", target, source],
        { env, allowFailure: true },
      )
      const output = text(merged)
      const conflictBlock = output.split("\0\0")[0]!
      const fields = conflictBlock.split("\0").map((field) => field.trim()).filter(Boolean)
      const tree = fields[0]!
      if (merged.code !== 0) {
        const paths = [...new Set(fields.slice(1))]
        return { ok: false, conflicts: paths }
      }
      const oid = await commitTree(tree, [targetOid, sourceOid], `merge ${source} into ${target}`, env)
      await run(["update-ref", `refs/heads/${target}`, oid])
      await syncWorkTree(target)
      return { ok: true, commit: oid as CommitId }
    },

    async diff(first, second) {
      const result = await run(["diff", "--name-status", "-z", first, second], { allowFailure: true })
      if (result.code !== 0) return []
      const fields = text(result).split("\0").filter(Boolean)
      const changes: FileChange[] = []
      for (let i = 0; i < fields.length; i += 2) {
        const statusLetter = fields[i]?.[0]
        const path = fields[i + 1]
        if (!path) continue
        const status = statusLetter === "A" ? "added" : statusLetter === "D" ? "removed" : "modified"
        const before = status === "added" ? null : await backend.readFile(first, path)
        const after = status === "removed" ? null : await backend.readFile(second, path)
        changes.push({ path, status, before, after })
      }
      return changes
    },
  }

  return backend
}

// Monotonic within a process so temp index files never collide.
let indexCounter = 0
