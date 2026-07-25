// =====================================================================
// store/smoke.ts — the vertical slice, proven end to end.
//
// Drives the real git backend against a throwaway data directory and
// walks the whole flow: sign in, create a project, create a part, apply
// parametric operations, rewind, seal a version, branch, merge, diff.
//
// Auth is stubbed (a fake AuthProvider) so the test needs no network or
// OAuth client — the GoogleAuthProvider is exercised separately. Storage
// is NOT stubbed: this hits the actual `git` binary, the same one prod
// self-host uses.
//
//   pnpm --filter @linen/store smoke
// =====================================================================

import { promises as fs } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createStore } from "./api"
import { createLocalBackend } from "./backend/local"
import type { AuthProvider } from "@linen/auth"

// A deterministic clock and id sequence, so a run is reproducible.
let tick = 0
const now = () => new Date(Date.UTC(2026, 6, 24, 12, 0, tick++)).toISOString()
let idCounter = 0
const newId = () => `id${(++idCounter).toString().padStart(4, "0")}`

// Stub provider: any credential "google:<sub>|<email>|<name>" verifies.
const fakeAuth: AuthProvider = {
  name: "google",
  async verify(credential) {
    const [subject = "", email = "", name = ""] = credential.split("|")
    return { ok: true, identity: { provider: "google", subject, email, name, picture: null } }
  },
}

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`  ok — ${message}`)
}

const main = async (): Promise<void> => {
  const root = join(tmpdir(), `linen-data-smoke-${process.pid}`)
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(root, { recursive: true })
  console.log(`data dir: ${root}\n`)

  const backend = createLocalBackend({ root })
  const store = createStore({ backend, auth: fakeAuth, now, newId })

  console.log("sign in")
  const account = await store.signIn("sub-123|ada@example.com|Ada Lovelace")
  assert(account.record.id === "google:sub-123", "account keyed by provider:subject")
  const again = await store.signIn("sub-123|ada@example.com|Ada Lovelace")
  assert(again.record.id === account.record.id, "second sign-in reuses the account")

  console.log("\nprojects")
  assert((await account.projects()).length === 0, "no projects yet")
  const project = await account.createProject("Bracket")
  assert((await account.projects()).length === 1, "one project after create")

  console.log("\nownership")
  const mallory = await store.signIn("sub-999|mallory@example.com|Mallory")
  let denied = false
  try {
    await mallory.openProject(project.record.id)
  } catch {
    denied = true
  }
  assert(denied, "a non-owner cannot open the project")

  console.log("\nparts + parametric history")
  const part = await project.createPart("Base plate")
  await part.apply({ name: "draft", plane: "XY", circles: 1 }, "draft base circle")
  await part.apply({ name: "extrude", distance: 12 }, "extrude 12mm")
  const afterTwo = await part.history()
  // History is scoped to THIS part's file: only the commits that touched
  // it — create part, draft, extrude — not the repo's init or the project
  // creation. Newest first.
  assert(afterTwo.length === 3, "part history has 3 commits (create part, draft, extrude)")
  assert(afterTwo[0]!.message === "extrude 12mm", "newest commit is the extrude")
  assert(part.record.operations.length === 2, "two operations applied")

  console.log("\nrewind")
  const draftCommit = afterTwo[1]!.commit // newest first, so [1] is the draft
  const atDraft = await part.at(draftCommit)
  assert(atDraft?.operations.length === 1, "part at draft commit has one operation")
  await part.rewindTo(draftCommit, "rewind to draft")
  assert(part.record.operations.length === 1, "rewind dropped the extrude operation")

  console.log("\nseal a version")
  await part.apply({ name: "extrude", distance: 20 }, "re-extrude 20mm")
  await part.seal("v1", "first sealed version")
  const versions = await part.versions()
  assert(versions.includes("v1"), "v1 tag exists")
  const sealed = await backend.resolveRef("v1")
  assert(sealed !== null, "sealed tag resolves to a commit")

  console.log("\nbranch + independent edit")
  await project.createBranch("variant")
  const variantPart = await project.openPart(part.record.id, "variant")
  await variantPart.apply({ name: "fillet", radius: 2 }, "add fillet on variant")
  const mainPart = await project.openPart(part.record.id, "main")
  assert(mainPart.record.operations.length === 2, "main unaffected by variant edit")
  assert(variantPart.record.operations.length === 3, "variant has the extra operation")

  console.log("\ndiff (feature level)")
  const changes = await variantPart.diff("main", "variant")
  assert(changes.length === 1, "exactly one file changed between branches")
  const change = changes[0]!
  assert(
    change.path === `projects/${project.record.id}/parts/${part.record.id}.json`,
    "the changed file is the part",
  )
  assert(change.status === "modified", "part was modified")
  const before = JSON.parse(new TextDecoder().decode(change.before!))
  const after = JSON.parse(new TextDecoder().decode(change.after!))
  assert(before.operations.length === 2 && after.operations.length === 3, "diff shows the added operation")

  console.log("\nmerge (clean, fast-forward on a fresh branch)")
  await project.createBranch("feature", "main")
  const featurePart = await project.openPart(part.record.id, "feature")
  await featurePart.apply({ name: "chamfer", size: 1 }, "chamfer on feature")
  const merge = await project.merge("feature", "main")
  assert(merge.ok, "feature merged into main cleanly")
  const mergedMain = await project.openPart(part.record.id, "main")
  assert(mergedMain.record.operations.length === 3, "main now carries the merged operation")

  console.log("\nall good — cleaning up")
  await fs.rm(root, { recursive: true, force: true })
  console.log("\nPASS")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
