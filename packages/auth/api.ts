// =====================================================================
// auth/api.ts — AUTHENTICATION CONTRACT.
//
// One interface, many providers. GoogleAuthProvider is the first
// implementation (see ./google.ts); a dev provider or another IdP plug
// into the same shape. Nothing above this file knows which one is wired.
//
// A provider turns an opaque credential (a Google id_token, say) into a
// stable, verified Identity. The `subject` is the provider's immutable
// user id — never the email, which changes; the email is display only.
// =====================================================================

export interface Identity {
  /** The provider's stable subject id (Google `sub`). Keys the account. */
  readonly subject: string
  readonly email: string
  readonly name: string
  readonly picture: string | null
  /** Which provider vouched for this identity, e.g. "google". Part of
   *  the account key, so two providers can never collide on a subject. */
  readonly provider: string
}

export type AuthResult =
  | { readonly ok: true; readonly identity: Identity }
  | { readonly ok: false; readonly reason: string }

export interface AuthProvider {
  /** Provider name, e.g. "google". */
  readonly name: string
  /** Verifies a credential and extracts the identity. Never throws for a
   *  bad credential — returns `{ ok: false }` so callers branch on data. */
  verify(credential: string): Promise<AuthResult>
}
