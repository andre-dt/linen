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

Grounding facts: planes today render ONLY in WebGL `scene.ts` (bodies + sketch + planes + origin). Cube CSS lives in `.cube-face-label` in `apps/web/styles.css` (font-size 80px, weight 600, letter-spacing 2px, color var(--hud-text)) — engine style tokens should absorb this. See [[[cube-label-html-in-canvas]]] if written.
