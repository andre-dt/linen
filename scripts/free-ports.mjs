// =====================================================================
// scripts/free-ports.mjs
//
// Frees the dev ports before starting, so a second `pnpm dev` never
// dies on "address already in use" — the usual cause being a previous
// run whose Vite or kernel outlived its terminal.
//
// Runs cross-platform: lsof/fuser on Unix, netstat on Windows. A port
// that is already free is not an error, so every failure path here is
// swallowed on purpose.
// =====================================================================

import { execSync } from "node:child_process"
import { platform } from "node:os"

const PORTS = [5173, 5174]

function pidsOnPort(port) {
  try {
    if (platform() === "win32") {
      const out = execSync(`netstat -ano -p tcp | findstr :${port}`, { stdio: ["ignore", "pipe", "ignore"] })
      return [...out.toString().matchAll(/LISTENING\s+(\d+)/g)].map((match) => match[1])
    }
    // -t: pids only. Empty output (nothing listening) makes lsof exit
    // non-zero, which is why this is wrapped.
    const out = execSync(`lsof -ti tcp:${port}`, { stdio: ["ignore", "pipe", "ignore"] })
    return out.toString().split("\n").filter(Boolean)
  } catch {
    return [] // nothing on the port
  }
}

for (const port of PORTS) {
  const pids = pidsOnPort(port)
  if (pids.length === 0) continue
  for (const pid of pids) {
    // Never kill ourselves: on some setups the shell running this script
    // can transiently show up on the port list.
    if (Number(pid) === process.pid) continue
    try {
      process.kill(Number(pid), "SIGTERM")
      console.log(`freed port ${port} (was pid ${pid})`)
    } catch {
      // Already gone, or not ours to kill. Either way the port is free
      // enough for the bind that follows.
    }
  }
}
