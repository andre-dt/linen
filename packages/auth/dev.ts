// =====================================================================
// auth/dev.ts — DevAuthProvider.
//
// A second implementation of AuthProvider, for local development before
// a Google OAuth client is provisioned. The credential is a plain string
// "<subject>|<email>|<name>"; there is no signature to verify. It exists
// only so the whole sign-in -> account -> dashboard flow can be exercised
// end to end without the network.
//
// NEVER wire this in production: it trusts whatever the client sends. The
// server enables it only when no GOOGLE_CLIENT_ID is configured, and says
// so out loud on startup.
// =====================================================================

import type { AuthProvider } from "./api"

export interface DevAuthOptions {
  /** The provider name recorded on the account. Defaults to "dev" so a
   *  dev account can never collide with a real "google" one. */
  readonly provider?: string
}

export const createDevAuthProvider = (options: DevAuthOptions = {}): AuthProvider => {
  const provider = options.provider ?? "dev"
  return {
    name: provider,
    async verify(credential) {
      const [subject = "", email = "", name = ""] = credential.split("|")
      if (!subject) return { ok: false, reason: "dev credential needs a subject" }
      return {
        ok: true,
        identity: {
          provider,
          subject,
          email: email || `${subject}@dev.local`,
          name: name || subject,
          picture: null,
        },
      }
    },
  }
}
