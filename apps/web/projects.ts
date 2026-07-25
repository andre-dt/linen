// =====================================================================
// apps/web/projects.ts — the dashboard's data client.
//
// Thin wrappers over the kernel's /projects routes. No reactive state
// here: the dashboard component owns its own signals and calls these to
// load and mutate. Every call carries the session cookie (same-origin).
// =====================================================================

export interface ProjectView {
  readonly id: string
  readonly name: string
}

export interface PartView {
  readonly id: string
  readonly name: string
}

const API = "/api"

// Reads the body as text once (a single-use stream), so the error path
// and the success path never both call .json() on the same response —
// and an empty body (proxied 5xx, dropped connection) becomes a clear
// error rather than "Unexpected end of JSON input".
//
// NOTE: automatic sign-out on 401 is DISABLED for now — it was dropping
// live sessions. A 401 is surfaced as a plain error instead; the user is
// not forced back to login. Re-enable the notifyAuthLost() hand-off once
// the session lifetime is solid.
const json = async <T>(response: Response): Promise<T> => {
  // if (response.status === 401) { notifyAuthLost(); throw new Error("session expired") }
  const text = await response.text()
  const parsed = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string })
  if (!response.ok) throw new Error(parsed.error ?? `HTTP ${response.status}`)
  return parsed
}

export const listProjects = async (): Promise<readonly ProjectView[]> =>
  json<{ projects: ProjectView[] }>(await fetch(`${API}/projects`, { credentials: "same-origin" })).then(
    (body) => body.projects,
  )

export const createProject = async (name: string): Promise<ProjectView> =>
  json<{ project: ProjectView }>(
    await fetch(`${API}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name }),
    }),
  ).then((body) => body.project)

export const getProject = async (projectId: string): Promise<ProjectView> =>
  json<{ project: ProjectView }>(
    await fetch(`${API}/projects/${projectId}`, { credentials: "same-origin" }),
  ).then((body) => body.project)

export const archiveProject = async (projectId: string, archived = true): Promise<void> => {
  await json<{ ok: boolean }>(
    await fetch(`${API}/projects/${projectId}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ archived }),
    }),
  )
}

export const listParts = async (projectId: string): Promise<readonly PartView[]> =>
  json<{ parts: PartView[] }>(
    await fetch(`${API}/projects/${projectId}/parts`, { credentials: "same-origin" }),
  ).then((body) => body.parts)

export const createPart = async (projectId: string, name: string): Promise<PartView> =>
  json<{ part: PartView }>(
    await fetch(`${API}/projects/${projectId}/parts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name }),
    }),
  ).then((body) => body.part)
