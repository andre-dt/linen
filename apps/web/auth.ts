// =====================================================================
// apps/web/auth.ts — client-side authentication state.
//
// The single source of truth for "who is signed in". On load it asks the
// server (GET /api/auth/me), which reads the session cookie: a returning
// user with a live cookie is resolved without ever seeing the login
// screen. Everything is a Solid signal so the gate re-renders when the
// account appears or disappears.
//
// The cookie is httpOnly, so this module never touches it directly — it
// only calls the endpoints that set and clear it.
// =====================================================================

import { createSignal } from "solid-js"

export interface AccountView {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly picture: string | null
}

export type AuthStatus = "loading" | "signed-out" | "signed-in"

export interface Auth {
  readonly status: () => AuthStatus
  readonly account: () => AccountView | null
  /** Re-reads /auth/me. Called once on load. */
  refresh(): Promise<void>
  /** Exchanges a Google id_token for a session. */
  signInWithGoogle(credential: string): Promise<void>
  signOut(): Promise<void>
}

const API = "/api"

// Google Identity Services, once loaded, exposes this. We only need to
// reset it: disabling auto-select and cancelling any pending prompt so a
// rejected sign-in forces a fresh, deliberate choice rather than silently
// re-submitting the same bad credential.
interface GoogleIdentityReset {
  accounts?: { id?: { disableAutoSelect?: () => void; cancel?: () => void } }
}

const resetGoogle = (): void => {
  const google = (window as unknown as { google?: GoogleIdentityReset }).google
  google?.accounts?.id?.disableAutoSelect?.()
  google?.accounts?.id?.cancel?.()
}

// A single place the whole app funnels "the session is gone" through, so a
// 401 from ANY endpoint ends the same way: reset Google and drop to the
// login screen. Registered by createAuth; called by the data client.
let authLost: (() => void) | null = null
export const notifyAuthLost = (): void => authLost?.()

const postJson = async (path: string, body: unknown): Promise<Response> =>
  fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  })

// Reads a response body as JSON, tolerating an empty body: a proxied 5xx,
// a dropped connection or a 204 can all arrive with no bytes, and
// Response.json() throws "Unexpected end of JSON input" on those. Reading
// the text once (the body is a single-use stream) and parsing by hand
// turns that into a clear error instead of a raw crash.
const parseJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text()
  if (!text) {
    if (response.ok) return {} as T
    throw new Error(`server error ${response.status}`)
  }
  return JSON.parse(text) as T
}

export function createAuth(): Auth {
  const [status, setStatus] = createSignal<AuthStatus>("loading")
  const [account, setAccount] = createSignal<AccountView | null>(null)

  const adopt = (next: AccountView | null): void => {
    setAccount(next)
    setStatus(next ? "signed-in" : "signed-out")
  }

  // Drop to the login screen and reset Google so the next attempt is a
  // fresh, deliberate one. Used on a rejected sign-in and on any 401.
  const toLogin = (): void => {
    resetGoogle()
    adopt(null)
  }

  // Registered so notifyAuthLost() from the data client routes here.
  authLost = toLogin

  const auth: Auth = {
    status,
    account,

    async refresh() {
      try {
        const response = await fetch(`${API}/auth/me`, { credentials: "same-origin" })
        const body = await parseJson<{ account: AccountView | null }>(response)
        adopt(body.account ?? null)
      } catch {
        // The kernel may not be up yet in dev; treat as signed out rather
        // than wedging on the loading screen.
        adopt(null)
      }
    },

    async signInWithGoogle(credential) {
      // The server only mints a session once the account is created/resolved
      // in git. Anything short of a returned account is a failure: reset
      // Google and stay on login — never proceed to the dashboard.
      try {
        const response = await postJson("/auth/google", { credential })
        const body = await parseJson<{ account?: AccountView; error?: string }>(response)
        if (!response.ok || !body.account) throw new Error(body.error ?? "sign-in failed")
        adopt(body.account)
      } catch (caught) {
        toLogin()
        throw caught
      }
    },

    async signOut() {
      try {
        await postJson("/auth/logout", {})
      } finally {
        toLogin()
      }
    },
  }

  return auth
}
