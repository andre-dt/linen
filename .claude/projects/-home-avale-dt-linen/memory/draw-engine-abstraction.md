---
name: draw-engine-abstraction
description: Plan for a backend-neutral low-level DrawEngine (WebGPU + WebGL2) with an internal HTML-in-Canvas writeLabel() primitive
metadata:
  type: project
---

Decided 2026-07-30: introduce a low-level, backend-neutral **DrawEngine** in `packages/viewer` with two implementations (WebGPU + WebGL2), and route all rendering through it. Goal set by the user.

Shape of the API: as low-level as the **common denominator** of both backends allows (meshes/buffers, textures, a small fixed set of named pipelines: fill / lines / label / billboard, draw), but it must **absorb all backend boilerplate** currently duplicated across `scene.ts`, `cube-scene.ts`, `cube-scene-gpu.ts`, `gl-renderer.ts`, `gpu-renderer.ts`.

Key primitive: **`writeLabel(text, styleToken)`** — engine internally uses HTML-in-Canvas (`texElementImage2D` on WebGL, `copyElementImageToTexture` on WebGPU — both already exist for the cube in `cube-face-texture.ts` / `cube-face-texture-gpu.ts`). Caller passes **NO CSS**: there is a single canonical font/color/style set, selected by a high-level **style token** name (e.g. `"cube-face"`, `"plane"`). Engine owns the DOM element, the copy-to-texture, the mip chain, and the onpaint/rAF retry.

Scope agreed (full): build the engine + BOTH impls completely, migrate the cube onto `writeLabel()` (delete the two cube-face-texture files), AND build the WebGPU main-scene renderer (today `gpu-renderer.ts createScene` throws) so datum planes render in both backends. Then datum-plane labels go through `writeLabel(plane.label, "plane")` so they get the crisp cube fonts (replacing `scene.ts`'s canvas2D `createTextTexture` path). Rationale for doing it now: drafting/CAD drawing hasn't started, so this is the moment to lay the rendering foundation.

DONE (2026-07-30). Implemented in `packages/viewer/engine/`: `engine.ts` (DrawEngine contract — meshes, `writeLabel(text, styleToken)`, 7 named pipelines: lit-mesh/flat-fill/flat-line/sketch-line/label/origin-billboard/cube-face, `frame(pass, draws)`), `label-style.ts` (canonical tokens `cube-face` + `plane`, owns the inline CSS), `label-texture.ts` (shared HTML-in-Canvas DOM element + paint-retry loop), `engine-gl.ts` (WebGL2, `texElementImage2D`), `engine-gpu.ts` (WebGPU, `copyElementImageToTexture` + MSAA + dynamic-offset uniform ring that grows). `scene.ts` fully rewritten to `createScene(engine)` — backend-neutral, plane labels via `writeLabel(..., "plane")`. Both renderers wired (`gpu-renderer.createScene` no longer throws); `apps/web/viewport.tsx` now uses `createConfiguredRenderer` ('auto' backend) instead of pinning WebGL2. Cube migrated: `cube-scene.ts` exports `createCubeSceneOnEngine`; `cube-scene-gpu.ts` is a thin wrapper. DELETED `cube-face-texture.ts`, `cube-face-texture-gpu.ts`, `text.ts`; removed `.cube-face-label` from styles.css. Viewer package typechecks clean; pre-existing unrelated errors remain in protocol/dropdown/cad. NOT yet done: runtime/visual verification in a browser (no headless GPU here).
