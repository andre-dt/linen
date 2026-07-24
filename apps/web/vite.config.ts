import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],

  server: {
    port: 5173,
    proxy: {
      // The kernel speaks two channels over one socket: JSON for
      // commands, binary for meshes. Vite proxies both so the browser
      // sees a single origin in development.
      "/session": { target: "ws://localhost:8080", ws: true },
    },
  },

  build: {
    target: "esnext", // top-level await, and WebGPU needs a modern baseline
    sourcemap: true,
  },

  worker: {
    format: "es",
  },

  optimizeDeps: {
    // Workspace packages are source, not built artifacts: pre-bundling
    // them would hide edits behind a stale cache.
    exclude: ["@linen/cad", "@linen/protocol", "@linen/viewer", "@linen/hud"],
  },
})
