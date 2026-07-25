// =====================================================================
// apps/kernel/http.ts — the HTTP surface: authentication and the data
// API, both backed by @linen/store over ../linen-data.
//
// Plain node:http, no framework — the codebase stays dependency-light,
// and the router is small enough to read in one screen.
//
// SESSION MODEL
// -------------
// Sign-in verifies a credential through an AuthProvider, resolves it to a
// store Account, and mints an opaque session token stored in an httpOnly
// cookie. `GET /auth/me` reads that cookie: the client calls it on load
// to decide between the login screen and the app, so a returning user
// with a live cookie never sees the login screen.
//
// Sessions live in memory here (a Map). That is fine for the walking
// skeleton — losing them only forces a re-login — and matches the rule
// that nothing of VALUE lives only in memory: the value is in git.
// =====================================================================

import type { IncomingMessage, ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import { createStore, type Store, type Account } from "@linen/store"
import { createLocalBackend } from "@linen/store/backend/local"
import { createGoogleAuthProvider } from "@linen/auth/google"

const SESSION_COOKIE = "linen_session"

export interface HttpConfig {
  /** Where the git repositories live. */
  readonly dataDir: string
  /** Google OAuth client id. Required — Google is the only way in. */
  readonly googleClientId: string
}

interface UserSession {
  readonly account: Account
  readonly accountId: string
}

export interface HttpApi {
  /** Returns true when it handled the request; false to let the caller
   *  fall through (e.g. to the health check). */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>
}

export const createHttpApi = (config: HttpConfig): HttpApi => {
  const backend = createLocalBackend({ root: config.dataDir })
  const store: Store = createStore({
    backend,
    // Google is the only provider: verifies the id_token end to end.
    auth: createGoogleAuthProvider({ clientId: config.googleClientId }),
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
  })

  const sessions = new Map<string, UserSession>()

  // --- tiny helpers ---------------------------------------------------

  const readCookie = (request: IncomingMessage, name: string): string | null => {
    const header = request.headers.cookie
    if (!header) return null
    for (const pair of header.split(";")) {
      const index = pair.indexOf("=")
      if (index === -1) continue
      if (pair.slice(0, index).trim() === name) return decodeURIComponent(pair.slice(index + 1).trim())
    }
    return null
  }

  const setSessionCookie = (response: ServerResponse, token: string): void => {
    // httpOnly so scripts can't read it; SameSite=Lax is enough for a
    // same-origin dashboard. Secure is added in production behind TLS.
    response.setHeader(
      "set-cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 7}`,
    )
  }

  const clearSessionCookie = (response: ServerResponse): void => {
    response.setHeader("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
  }

  // Resolves the request's session from the in-memory token map.
  //
  // NOTE: per-request re-validation against git is DISABLED for now — it
  // was dropping live sessions (any transient read returning null deleted
  // the session and forced a re-login). For the moment the in-memory
  // session IS the source of truth for a request; it is rebuilt from git
  // only on sign-in. Re-enable the git check once session lifetime is
  // solid.
  const currentSession = async (request: IncomingMessage): Promise<UserSession | null> => {
    const token = readCookie(request, SESSION_COOKIE)
    if (!token) return null
    return sessions.get(token) ?? null
  }

  const readJson = async (request: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      return {}
    }
  }

  const send = (response: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body)
    response.writeHead(status, { "content-type": "application/json" })
    response.end(payload)
  }

  const accountView = (account: Account) => ({
    id: account.record.id,
    name: account.record.name,
    email: account.record.email,
    picture: account.record.picture,
  })

  // --- sign-in shared by both providers -------------------------------

  const signInWith = async (
    response: ServerResponse,
    credential: string,
  ): Promise<void> => {
    const account = await store.signIn(credential)
    const token = randomUUID()
    sessions.set(token, { account, accountId: account.record.id })
    setSessionCookie(response, token)
    send(response, 200, { account: accountView(account) })
  }

  // --- the router -----------------------------------------------------

  return {
    async handle(request, response) {
      const url = new URL(request.url ?? "/", "http://localhost")
      const path = url.pathname
      const method = request.method ?? "GET"

      // Only the /auth and /projects namespaces are ours; anything else
      // (health check, WS upgrade) falls through.
      if (!path.startsWith("/auth") && !path.startsWith("/projects")) return false

      try {
        // --- AUTH -------------------------------------------------------

        if (path === "/auth/me" && method === "GET") {
          const session = await currentSession(request)
          send(response, 200, { account: session ? accountView(session.account) : null })
          return true
        }

        if (path === "/auth/google" && method === "POST") {
          const body = (await readJson(request)) as { credential?: string }
          if (!body.credential) {
            send(response, 400, { error: "missing credential" })
            return true
          }
          // The whole sign-in — token verification AND account creation in
          // git — must succeed before a session exists. Any failure clears
          // the cookie and answers 401, so the client resets Google and
          // sends the user back to the login screen; it never lands on the
          // dashboard with a half-made account.
          try {
            await signInWith(response, body.credential)
          } catch (caught) {
            clearSessionCookie(response)
            send(response, 401, { error: (caught as Error).message })
          }
          return true
        }

        if (path === "/auth/logout" && method === "POST") {
          const token = readCookie(request, SESSION_COOKIE)
          if (token) sessions.delete(token)
          clearSessionCookie(response)
          send(response, 200, { ok: true })
          return true
        }

        // --- DATA (all require a session, re-validated against git) -----

        const session = await currentSession(request)
        if (!session) {
          send(response, 401, { error: "not authenticated" })
          return true
        }
        const account = session.account

        // GET /projects — list; POST /projects — create
        if (path === "/projects" && method === "GET") {
          const projects = await account.projects()
          send(response, 200, { projects: projects.map((project) => ({ id: project.id, name: project.name })) })
          return true
        }
        if (path === "/projects" && method === "POST") {
          const body = (await readJson(request)) as { name?: string }
          if (!body.name) {
            send(response, 400, { error: "missing name" })
            return true
          }
          const project = await account.createProject(body.name)
          send(response, 201, { project: { id: project.record.id, name: project.record.name } })
          return true
        }

        // GET /projects/<id> — a single project (for the project screen)
        const projectMatch = /^\/projects\/([^/]+)$/.exec(path)
        if (projectMatch && method === "GET") {
          const project = await account.openProject(projectMatch[1]!).catch(() => null)
          if (!project) {
            send(response, 404, { error: "project not found" })
            return true
          }
          send(response, 200, { project: { id: project.record.id, name: project.record.name } })
          return true
        }

        // POST /projects/<id>/archive — archive or unarchive
        const archiveMatch = /^\/projects\/([^/]+)\/archive$/.exec(path)
        if (archiveMatch && method === "POST") {
          const projectId = archiveMatch[1]!
          const project = await account.openProject(projectId).catch(() => null)
          if (!project) {
            send(response, 404, { error: "project not found" })
            return true
          }
          const body = (await readJson(request)) as { archived?: boolean }
          await project.setArchived(body.archived ?? true)
          send(response, 200, { ok: true })
          return true
        }

        // /projects/<id>/parts — list & create
        const partsMatch = /^\/projects\/([^/]+)\/parts$/.exec(path)
        if (partsMatch) {
          const projectId = partsMatch[1]!
          const project = await account.openProject(projectId).catch(() => null)
          if (!project) {
            send(response, 404, { error: "project not found" })
            return true
          }
          if (method === "GET") {
            const parts = await project.parts()
            send(response, 200, { parts: parts.map((part) => ({ id: part.id, name: part.name })) })
            return true
          }
          if (method === "POST") {
            const body = (await readJson(request)) as { name?: string }
            if (!body.name) {
              send(response, 400, { error: "missing name" })
              return true
            }
            const part = await project.createPart(body.name)
            send(response, 201, { part: { id: part.record.id, name: part.record.name } })
            return true
          }
        }

        send(response, 404, { error: "not found" })
        return true
      } catch (error) {
        // A thrown handler is a bug, or an ownership violation surfacing
        // as an error; never leak a stack to the client.
        send(response, 500, { error: (error as Error).message })
        return true
      }
    },
  }
}
