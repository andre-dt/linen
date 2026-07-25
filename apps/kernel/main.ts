// =====================================================================
// apps/kernel/main.ts — the kernel process entry point.
//
// Listens on PORT (5174 in dev, proxied by Vite under /api) and speaks
// the two-channel protocol from @linen/protocol: JSON for commands and
// tree deltas, binary frames for meshes.
//
// This is a WALKING SKELETON. It opens a session, echoes the protocol
// handshake, and acknowledges commands — enough to prove the transport
// end to end before the OCCT addon is compiled. Every place that will
// call the kernel is marked; none of them fabricate geometry, so what
// works here keeps working once the real kernel is linked.
// =====================================================================

import { createServer } from "node:http"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocketServer, type WebSocket } from "ws"
import type {
  ClientMessage, ServerMessage, SessionInfo,
} from "@linen/protocol"
import { standardPreset } from "@linen/cad/features"
import { createHttpApi } from "./http"

const PORT = Number(process.env.PORT ?? 5174)

// The git-backed data + auth API. Data lives outside the source tree in
// ../linen-data by default (override with LINEN_DATA_DIR). Sign-in is
// Google-only: GOOGLE_CLIENT_ID is required, loaded from apps/kernel/.env
// in dev. This file is apps/kernel/main.ts, so the repo root is two
// levels up and ../linen-data sits beside it.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
if (!GOOGLE_CLIENT_ID) {
  console.error(
    "GOOGLE_CLIENT_ID is not set. Sign-in is Google-only; create an OAuth client\n" +
      "in the Google Cloud console and put it in apps/kernel/.env before starting.",
  )
  process.exit(1)
}
// A well-formed Web-application client id is "<digits>-<32 lowercase
// alphanumerics>.apps.googleusercontent.com". Catching a malformed one
// here turns a silent "sign-in always fails" into an obvious startup
// error — the exact confusion of an id copied with a stray prefix.
if (!/^\d+-[a-z0-9]{32}\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID)) {
  console.error(
    `GOOGLE_CLIENT_ID does not look like a Google OAuth client id:\n  ${GOOGLE_CLIENT_ID}\n` +
      "Expected <digits>-<32 chars>.apps.googleusercontent.com — check for a stray\n" +
      "prefix or a truncated copy. It must match VITE_GOOGLE_CLIENT_ID in the client.",
  )
  process.exit(1)
}
const httpApi = createHttpApi({
  dataDir: process.env.LINEN_DATA_DIR ?? resolve(repoRoot, "..", "linen-data"),
  googleClientId: GOOGLE_CLIENT_ID,
})

// The capabilities the real OCCT adapter will advertise. Hardcoded for
// now so the client can grey out unsupported toolbar entries before the
// addon exists. This is the one list that must match what occt/ links.
const CAPABILITIES = standardPreset
  .flatMap((feature) => feature.commands)
  .flatMap((command) => command.requires)
  .filter((id, index, all) => all.indexOf(id) === index)

const http = createServer((request, response) => {
  // Auth + data routes first; the API returns false for anything it does
  // not own, which falls through to the health check below.
  httpApi
    .handle(request, response)
    .then((handled) => {
      if (handled) return
      // A health check, so `curl /api/` returns something legible rather
      // than an unexplained upgrade failure.
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("linen kernel\n")
    })
    .catch((error) => {
      response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: (error as Error).message }))
    })
})

const sockets = new WebSocketServer({ server: http })

sockets.on("connection", (socket: WebSocket) => {
  let session: SessionInfo | null = null

  socket.on("message", (raw, isBinary) => {
    // Binary frames are mesh uploads, which flow server -> client only.
    // A binary frame arriving here is a protocol error, not data.
    if (isBinary) {
      socket.close(1003, "unexpected binary frame from client")
      return
    }

    let message: ClientMessage
    try {
      message = JSON.parse(raw.toString())
    } catch {
      socket.close(1007, "malformed message")
      return
    }

    handle(message)
  })

  function send(message: ServerMessage): void {
    socket.send(JSON.stringify(message))
  }

  function handle(message: ClientMessage): void {
    switch (message.kind) {
      case "session.open": {
        session = {
          session: crypto.randomUUID() as SessionInfo["session"],
          project: message.project,
          branch: message.branch,
          timeToLive: 300,
          kernel: { name: "occt", version: "7.8.1" },
          capabilities: CAPABILITIES,
        }
        send({ kind: "session.opened", info: session })
        break
      }

      case "command.apply": {
        // TODO: hand the command to the session's feature tree, which
        // regenerates and tessellates. For now, acknowledge with an
        // empty delta so the client's request/response loop is exercised.
        send({
          kind: "command.applied",
          request: message.request,
          delta: {
            commit: "0".repeat(40),
            added: [],
            updated: [],
            removed: [],
            meshes: [],
            discarded: [],
            diagnostics: [],
          },
        })
        // Mesh frames would follow here on the binary channel.
        break
      }

      case "command.preview":
      case "selector.resolve":
        // Silently ignored until the kernel exists: acknowledging a
        // preview we cannot compute would be a lie the client acts on.
        break

      case "session.close":
        socket.close(1000, "closed by client")
        break

      default:
        // Unknown or not-yet-implemented message kinds are dropped
        // rather than crashing the connection.
        break
    }
  }
})

http.listen(PORT, () => {
  console.log(`linen kernel listening on http://localhost:${PORT}`)
  console.log(`capabilities: ${CAPABILITIES.join(", ")}`)
  console.log("auth: Google")
})
