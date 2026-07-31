import solidPlugin from "vite-plugin-solid"
import { defineConfig } from "vitest/config"

// Two kinds of test, split into vitest PROJECTS so each gets the right
// environment and transform:
//
//   node — pure logic with no DOM or GPU: the geometry and camera math in
//          packages/viewer. Plain *.test.ts, run in Node.
//
//   dom  — SolidJS components rendered into a DOM (happy-dom) and driven
//          with @solidjs/testing-library: the provider/context behaviours
//          in apps/web. *.test.tsx, compiled by vite-plugin-solid so JSX
//          and reactivity work. This is where the 3D world's orchestration
//          layer is tested — mount a provider, act, assert the outcome —
//          rather than by poking internals.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["packages/**/*.test.ts"],
        },
      },
      {
        extends: true,
        plugins: [solidPlugin()],
        // Resolve Solid's browser/development build so its JSX runtime
        // (solid-js/web) is present when rendering into happy-dom.
        resolve: {
          conditions: ["development", "browser"],
        },
        test: {
          name: "dom",
          environment: "happy-dom",
          include: ["apps/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.ts"],
          server: { deps: { inline: [/solid-js/, /@solidjs/] } },
        },
      },
    ],
  },
})
