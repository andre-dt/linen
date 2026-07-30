import { defineConfig } from "vitest/config"

// Root vitest config. Tests are colocated with the code they cover
// (`*.test.ts` next to the module), and run in Node — the suites here
// exercise the PURE geometry and camera math, which have no DOM or GPU
// dependency. Anything needing a real device is out of scope for unit
// tests by design: the view cube is split so its behaviour lives in
// plain functions (buildCube, pickCube, createCamera) that a headless
// runner can drive directly.
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
  },
})
