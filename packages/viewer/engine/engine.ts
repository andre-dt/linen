// =====================================================================
// packages/viewer/engine/engine.ts — THE LOW-LEVEL DRAWING ENGINE.
//
// One drawing vocabulary, two implementations (WebGPU + WebGL2). Every
// pixel the viewer puts on screen goes through this contract; nothing
// above it ever touches a GPUDevice, a WebGL2RenderingContext, a VAO, a
// pipeline, or a shader. That is the same discipline the kernel contract
// applies to OCCT — the backend is an implementation detail, and the
// layers above are written once.
//
// AS LOW AS THE DENOMINATOR ALLOWS, NO LOWER
// ------------------------------------------
// The surface is deliberately small and low-level: upload a mesh, upload
// a label, draw a batch under a named pipeline. It is NOT a scene graph
// and NOT a material system — the scene above composes those from these
// primitives. But it IS high enough to erase the boilerplate that was
// duplicated across scene.ts / cube-scene.ts / cube-scene-gpu.ts: pipeline
// state combinations, uniform packing, MSAA targets, the HTML-in-Canvas
// label dance. Each of those has exactly ONE home now, behind this line.
//
// PIPELINES ARE NAMED STATE, NOT SHADERS YOU WRITE
// ------------------------------------------------
// WebGL sets depth/blend/cull imperatively; WebGPU bakes them into
// immutable pipeline objects. The denominator is WebGPU's model — a fixed
// enumeration of the state combinations the viewer actually needs — so the
// caller picks a `Pipeline` by name and the backend owns the shader and
// the state behind it. Adding a new visual style is adding a case here and
// in both backends, never a stray `gl.enable` at a call site.
//
// LABELS ARE HTML, AND THE ENGINE OWNS THE CSS
// --------------------------------------------
// `writeLabel(text, style)` returns a texture whose pixels are a real,
// browser-laid-out HTML element (see label-texture.ts). The caller passes
// only TEXT and a STYLE TOKEN — never CSS. There is one canonical set of
// label styles (label-style.ts); the token selects among them. This is
// what makes a datum-plane name look exactly as crisp as a view-cube
// face, and why the softer canvas2D `text.ts` path is retired for both.
// =====================================================================

import type { Matrix } from "../math"
import type { LabelStyleToken } from "./label-style"

// =====================================================================
// 1. HANDLES — opaque references to backend-owned resources
// =====================================================================

/**
 * A GPU mesh: vertices (and optionally indices) uploaded once, drawn many
 * times. The fields are read-only bookkeeping the engine needs at draw
 * time; the actual buffers live inside the backend and never surface here.
 */
export interface MeshHandle {
  /** The vertex layout this mesh was built with — the pipeline it draws
   *  under must expect the same one. */
  readonly layout: VertexLayout
  /** Vertices for a non-indexed draw, or the count addressed by indices. */
  readonly vertexCount: number
  /** Present only for indexed meshes (bodies). Absent means a plain
   *  `draw(vertexCount)`. */
  readonly indexCount: number | null
  /** True when `update` may be called — a dynamic buffer sized for reuse,
   *  as the sketch needs. Static meshes reject updates. */
  readonly dynamic: boolean
  /** Opaque backend payload. Never read above the engine. */
  readonly resource: unknown
}

/**
 * A text label backed by a live HTML element and a GPU texture. The
 * element stays in the DOM (so accessibility and CSS keep working) and its
 * painted pixels are copied into `.texture`'s backing on paint. `aspect`
 * (width / height of the drawn box) is what the caller sizes a quad by so
 * the glyphs are never stretched.
 */
export interface LabelHandle {
  readonly aspect: number
  /** Opaque backend payload (the texture + view + the DOM element). */
  readonly resource: unknown
}

// =====================================================================
// 2. VERTEX LAYOUTS — the shapes of vertex data the viewer uses
// =====================================================================

/**
 * The interleaved vertex formats the whole viewer needs. Kept to a closed
 * set so each backend can pre-declare the matching buffer layout once
 * rather than parsing an arbitrary descriptor.
 *
 *   position         — flat lines: plane fills/outlines, axes, sketch.
 *   position-uv      — textured quads: labels.
 *   position-normal  — lit or shaded surfaces: bodies, the origin marker.
 *
 * Bodies are the one source that arrives non-interleaved (separate
 * position and normal buffers); `createMesh` interleaves them so the
 * engine has a single internal representation.
 */
export type VertexLayout = "position" | "position-uv" | "position-normal"

/** Floats per vertex for each layout — what `createMesh` strides by. */
export const FLOATS_PER_VERTEX: Record<VertexLayout, number> = {
  "position": 3,
  "position-uv": 5,
  "position-normal": 6,
}

// =====================================================================
// 3. PIPELINES — the named state combinations the viewer draws with
// =====================================================================

/**
 * Every distinct (shader + depth + blend + cull + topology) combination the
 * viewer uses, enumerated. This IS the denominator between the two
 * backends: WebGL flips global state to reach each of these, WebGPU bakes
 * one pipeline object per case; both start from this list.
 *
 *   lit-mesh         — bodies. Depth test + write, cull back, opaque.
 *                      Layout position-normal, triangles.
 *   flat-fill        — plane fills. Depth test, NO depth write, no cull,
 *                      alpha blend. Layout position, triangles.
 *   flat-line        — plane outlines & axes. Same state as flat-fill but
 *                      line-list. Layout position.
 *   sketch-line      — the sketch. Depth test OFF (always on top), alpha
 *                      blend, line-list. Layout position.
 *   label            — text quads stamped into a surface. Depth test, NO
 *                      write, alpha blend, no cull, samples a label
 *                      texture. Layout position-uv, triangles.
 *   origin-billboard — the origin marker. A screen-space-sized shaded
 *                      sphere: depth test + write, opaque, triangles.
 *                      Layout position-normal.
 *   cube-face        — a view-cube plate. Depth test + write, cull back,
 *                      opaque, samples a label texture, tintable/hoverable.
 *                      Layout position-uv, triangles.
 */
export type Pipeline =
  | "lit-mesh"
  | "flat-fill"
  | "flat-line"
  | "sketch-line"
  | "label"
  | "origin-billboard"
  | "cube-face"

// =====================================================================
// 4. UNIFORMS — the per-draw data each pipeline reads
// =====================================================================

/**
 * The full set of per-draw parameters. Each pipeline reads the subset it
 * needs and ignores the rest; a single flat struct keeps the call sites
 * uniform (pun intended) and lets the backend pack once. `null` fields are
 * simply not consulted by pipelines that do not use them.
 */
export interface DrawUniforms {
  /** Clip-from-world. Every pipeline uses it. */
  readonly viewProjection: Matrix
  /** World-from-local, for meshes drawn in their own frame (bodies).
   *  Identity for everything already authored in world space. */
  readonly model?: Matrix
  /** Base colour / tint. */
  readonly color?: readonly [number, number, number]
  /** Blend/coverage opacity for flat and label pipelines. */
  readonly opacity?: number
  /** Directional light, for lit-mesh and origin-billboard. */
  readonly lightDirection?: readonly [number, number, number]
  /** Drawing-buffer size in physical pixels, for the origin billboard's
   *  screen-space sizing. */
  readonly viewport?: readonly [number, number]
  /** The origin marker's on-screen radius in physical pixels. */
  readonly pixelRadius?: number
  /** 1 while a cube face is hovered, for its highlight mix. */
  readonly highlighted?: number
  /** 1 when a cube face carries a label texture to composite. */
  readonly labelled?: number
}

/** One draw: a mesh, the pipeline that draws it, its uniforms, and — for
 *  textured pipelines — the label to sample. */
export interface DrawCall {
  readonly mesh: MeshHandle
  readonly pipeline: Pipeline
  readonly uniforms: DrawUniforms
  /** Required by `label` and `cube-face`; ignored otherwise. */
  readonly label?: LabelHandle | null
}

// =====================================================================
// 5. FRAMES — a clear plus a sequence of draws
// =====================================================================

/** How a frame begins: clear to a colour (opaque scenes) or to fully
 *  transparent (the cube floats over the HUD). Depth always clears to far. */
export interface FramePass {
  /** RGBA clear. Alpha 0 makes the canvas see-through where nothing draws. */
  readonly clear: readonly [number, number, number, number]
}

// =====================================================================
// 6. THE ENGINE CONTRACT
// =====================================================================

/**
 * A live drawing engine bound to one canvas' context. Created by a backend
 * factory (createGlEngine / createGpuEngine); the scene and cube code hold
 * only this interface.
 */
export interface DrawEngine {
  readonly backend: "webgpu" | "webgl2"

  /**
   * Upload an interleaved static mesh. `data` is `FLOATS_PER_VERTEX[layout]`
   * floats per vertex. `indices`, when given, makes it an indexed draw.
   */
  createMesh(
    data: Float32Array,
    layout: VertexLayout,
    indices?: Uint32Array,
  ): MeshHandle

  /**
   * Upload a mesh whose vertex data will be replaced often (the sketch).
   * `capacityVertices` sizes the buffer up front so `update` never
   * reallocates. Always non-indexed.
   */
  createDynamicMesh(
    layout: VertexLayout,
    capacityVertices: number,
  ): MeshHandle

  /** Replace a dynamic mesh's vertices. `vertexCount` becomes the new draw
   *  count. Throws if the mesh is static or the data exceeds capacity. */
  updateMesh(mesh: MeshHandle, data: Float32Array, vertexCount: number): void

  /** Free a mesh's GPU resources. */
  destroyMesh(mesh: MeshHandle): void

  /**
   * Create a text label as a live HTML element under the canvas and its
   * destination texture. The element is styled ENTIRELY by `style` (a token
   * into the canonical set); the caller passes no CSS. The pixels are not
   * ready until the element has painted — the engine copies them on paint
   * internally, so the caller just draws the returned handle and it fills in
   * within a frame or two.
   */
  writeLabel(text: string, style: LabelStyleToken): LabelHandle

  /** Free a label's texture and remove its DOM element. */
  destroyLabel(label: LabelHandle): void

  /** Draw a frame: clear, then run every draw call in order. */
  frame(pass: FramePass, draws: readonly DrawCall[]): void

  /** Match the drawing buffer to a new CSS size and device-pixel ratio. */
  resize(width: number, height: number, devicePixelRatio: number): void

  /** Release the backend and everything created from it. */
  dispose(): void
}
