import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],

  server: {
    port: 5173,
    proxy: {
      // The kernel runs on 5174 and speaks two channels over one socket:
      // JSON for commands, binary for meshes. Vite proxies both under
      // /api so the browser sees a single origin in development.
      //
      // ws: true upgrades the WebSocket; the rewrite drops the /api
      // prefix so the kernel sees the path it actually serves.
      "/api": {
        target: "http://localhost:5188",
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
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
