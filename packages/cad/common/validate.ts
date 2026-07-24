// =====================================================================
// packages/cad/common/validate.ts
//
// A placeholder validator.
//
// The schema exists to reject malformed input at the boundary — a
// command arriving over the socket, or one replayed from git written by
// an older version. Until those paths exist there is nothing to reject,
// so this passes the value through.
//
// It is deliberately a real value rather than a `declare const`: a
// declaration compiles but evaporates, leaving `undefined` at runtime in
// a place nothing checks. Zod replaces this once persistence lands.
// =====================================================================

import type { Validator } from "./kernel"

export function passthrough<T>(): Validator<T> {
  return { parse: (input: unknown) => input as T }
}
