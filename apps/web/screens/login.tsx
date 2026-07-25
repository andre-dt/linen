// =====================================================================
// apps/web/screens/login.tsx — the sign-in screen.
//
// The app's default face: shown whenever there is no live session. One
// way in — Google Identity Services. When VITE_GOOGLE_CLIENT_ID is set,
// the GIS script renders its own button and hands us an id_token, which
// we POST to /auth/google; the server verifies it and mints a session.
//
// Look: nothing at all — a plain white field with the Google button
// centred in it. No card, no brand, no chrome. The whole screen is the
// one action.
// =====================================================================

import { createSignal, onMount, Show } from "solid-js"
import type { Auth } from "../auth"

// Injected by Vite at build time; empty string when unset.
const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? ""

// Minimal shape of the Google Identity Services global we use.
interface GoogleIdentity {
  accounts: {
    id: {
      initialize(config: { client_id: string; callback: (response: { credential: string }) => void }): void
      renderButton(parent: HTMLElement, options: Record<string, unknown>): void
    }
  }
}

export function Login(props: { auth: Auth }) {
  const [error, setError] = createSignal<string | null>(null)
  let googleButton: HTMLDivElement | undefined

  const loadGoogleScript = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if ((window as unknown as { google?: GoogleIdentity }).google) return resolve()
      const script = document.createElement("script")
      script.src = "https://accounts.google.com/gsi/client"
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => reject(new Error("failed to load Google sign-in"))
      document.head.appendChild(script)
    })

  onMount(async () => {
    if (!GOOGLE_CLIENT_ID || !googleButton) return
    try {
      await loadGoogleScript()
      const google = (window as unknown as { google: GoogleIdentity }).google
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (response) => {
          setError(null)
          try {
            await props.auth.signInWithGoogle(response.credential)
          } catch (caught) {
            setError((caught as Error).message)
          }
        },
      })
      google.accounts.id.renderButton(googleButton, { theme: "outline", size: "large", shape: "pill" })
    } catch (caught) {
      setError((caught as Error).message)
    }
  })

  return (
    <div class="login-scene">
      <Show
        when={GOOGLE_CLIENT_ID}
        fallback={<p class="login-note">Set VITE_GOOGLE_CLIENT_ID to enable Google sign-in.</p>}
      >
        <div class="login-google" ref={googleButton} />
      </Show>

      <Show when={error()}>
        {(message) => <p class="login-error">{message()}</p>}
      </Show>
    </div>
  )
}
