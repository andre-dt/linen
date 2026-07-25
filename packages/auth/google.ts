// =====================================================================
// auth/google.ts — GoogleAuthProvider.
//
// One implementation of AuthProvider (see ./api.ts). Verifies a Google
// OpenID Connect `id_token` end to end — RS256 signature against
// Google's published keys, plus issuer, audience and expiry — using only
// Node's built-in crypto and global fetch. No SDK.
//
// Plug-and-play: swap this for a DevAuthProvider or another IdP behind
// the same interface and nothing above the store changes.
// =====================================================================

import { createPublicKey, createVerify } from "node:crypto"
import type { AuthProvider, AuthResult } from "./api"

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"])
const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"

export interface GoogleAuthOptions {
  /** OAuth client id; the token's `aud` must equal this. Required — a
   *  provider that skips the audience check accepts tokens minted for
   *  any other app. */
  readonly clientId: string
  /** Overridable for tests; defaults to Google's JWKS endpoint. */
  readonly fetchImplementation?: typeof fetch
  /** Clock skew tolerance in seconds. */
  readonly clockSkewSeconds?: number
  /** Deterministic clock (seconds since epoch), injectable for tests. */
  readonly nowSeconds?: () => number
}

interface Jwk {
  readonly kid: string
  readonly n: string
  readonly e: string
  readonly kty: string
  readonly alg: string
  readonly use?: string
}

interface GoogleClaims {
  readonly iss: string
  readonly aud: string
  readonly sub: string
  readonly exp: number
  readonly email?: string
  readonly email_verified?: boolean
  readonly name?: string
  readonly picture?: string
}

const decodeSegment = (segment: string): Buffer => Buffer.from(segment, "base64url")

// A minimal JWKS cache keyed by the endpoint's Cache-Control max-age, so
// verification does not hit Google on every sign-in.
interface CachedKeys {
  keys: Jwk[]
  expiresAtSeconds: number
}

export const createGoogleAuthProvider = (options: GoogleAuthOptions): AuthProvider => {
  const doFetch = options.fetchImplementation ?? fetch
  const skew = options.clockSkewSeconds ?? 60
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  let cache: CachedKeys | null = null

  const keyFor = async (kid: string): Promise<Jwk | null> => {
    const now = nowSeconds()
    if (!cache || now >= cache.expiresAtSeconds) {
      const response = await doFetch(GOOGLE_CERTS_URL)
      const body = (await response.json()) as { keys: Jwk[] }
      const cacheControl = response.headers.get("cache-control") ?? ""
      const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1] ?? 3600)
      cache = { keys: body.keys, expiresAtSeconds: now + maxAge }
    }
    return cache.keys.find((key) => key.kid === kid) ?? null
  }

  const fail = (reason: string): AuthResult => ({ ok: false, reason })

  return {
    name: "google",

    async verify(credential) {
      const parts = credential.split(".")
      if (parts.length !== 3) return fail("malformed token")
      const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string]

      let header: { kid?: string; alg?: string }
      let claims: GoogleClaims
      try {
        header = JSON.parse(decodeSegment(headerSegment).toString("utf8"))
        claims = JSON.parse(decodeSegment(payloadSegment).toString("utf8"))
      } catch {
        return fail("unparseable token")
      }

      if (header.alg !== "RS256") return fail(`unexpected algorithm: ${header.alg}`)
      if (!header.kid) return fail("missing key id")

      const jwk = await keyFor(header.kid)
      if (!jwk) return fail("signing key not found")

      // Verify the RS256 signature over "header.payload".
      // node's crypto.JsonWebKey is a loose Record; a JWK from Google
      // satisfies it structurally once handed over as such.
      const publicKey = createPublicKey({ key: jwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" })
      const verifier = createVerify("RSA-SHA256")
      verifier.update(`${headerSegment}.${payloadSegment}`)
      verifier.end()
      const signatureValid = verifier.verify(publicKey, decodeSegment(signatureSegment))
      if (!signatureValid) return fail("signature verification failed")

      // Standard OIDC claim checks: issuer, audience, expiry.
      if (!GOOGLE_ISSUERS.has(claims.iss)) return fail(`untrusted issuer: ${claims.iss}`)
      if (claims.aud !== options.clientId) return fail("audience mismatch")
      if (nowSeconds() > claims.exp + skew) return fail("token expired")
      if (!claims.sub) return fail("missing subject")

      return {
        ok: true,
        identity: {
          provider: "google",
          subject: claims.sub,
          email: claims.email ?? "",
          name: claims.name ?? claims.email ?? claims.sub,
          picture: claims.picture ?? null,
        },
      }
    },
  }
}
