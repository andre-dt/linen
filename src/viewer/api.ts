// =====================================================================
// src/viewer/api.ts — CLIENT RENDERING.
//
// WebGPU with a WebGL2 fallback, plus a small WASM module.
//
// WHAT THE WASM IS NOT
// --------------------
// It is not a second kernel. All geometry runs on the server; the client
// never evaluates a feature. The WASM module does exactly three things,
// all of them hot loops that would stall the main thread in JavaScript:
//
//   1. mesh decode        unpack the binary buffer into GPU-ready views
//   2. picking            ray/triangle intersection against the hierarchy
//   3. bounding volumes   build that hierarchy once per mesh upload
//
// Everything else — scene graph, camera, materials, highlight state —
// stays in TypeScript, where it is debuggable.
//
// THE BUFFER IS THE CONTRACT
// --------------------------
// The mesh layout in common/kernel.ts travels native -> socket -> GPU
// with no re-serialization. Positions and normals are uploaded straight
// from the received ArrayBuffer, and the face groups drive both picking
// and per-face highlighting.
// =====================================================================

import type {
  BodyId, EntityId, Vector2, Vector3, Matrix4, BoundingBox, FaceGroup,
} from "../common/kernel"

// =====================================================================
// 1. BACKEND
// =====================================================================
// WebGPU is the target; WebGL2 exists because some drivers and older
// browsers still block it. The two share every type below — only the
// implementation differs.

export type BackendKind = "webgpu" | "webgl2"

export interface Backend {
  readonly kind: BackendKind
  readonly canvas: HTMLCanvasElement
  readonly limits: BackendLimits
  dispose(): void
}

export interface BackendLimits {
  readonly maxTextureSize: number
  readonly maxBufferSize: number
  /** WebGPU only. Absent on WebGL2, where picking falls back to reading
   *  an auxiliary render target. */
  readonly supportsComputeShaders: boolean
  readonly supportsTimestampQuery: boolean
}

/** Picks WebGPU when available, otherwise WebGL2. Never throws for a
 *  missing WebGPU: that is the expected path, not an error. */
export type CreateBackend = (
  canvas: HTMLCanvasElement,
  preference?: BackendKind,
) => Promise<Backend>
export declare const createBackend: CreateBackend

// =====================================================================
// 2. WASM MODULE
// =====================================================================
// Narrow surface, heavy payloads — the same rule as the N-API boundary.
// One call per mesh, never one call per triangle.

export interface MeshCodec {
  /**
   * Validates the header and returns typed views INTO the same buffer.
   * No copying: those views are uploaded to the GPU as they are.
   */
  decode(buffer: ArrayBuffer): DecodedMesh
  /** Built once per upload; every picking query reuses it. */
  buildBoundingVolumeHierarchy(mesh: DecodedMesh): BoundingVolumeHierarchy
}

export interface DecodedMesh {
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly indices: Uint32Array
  readonly faceGroups: readonly FaceGroup[]
  readonly bounds: BoundingBox
}

export interface BoundingVolumeHierarchy {
  readonly nodeCount: number
  /** Opaque handle into WASM memory. Released with `dispose`. */
  readonly handle: number
  dispose(): void
}

export type LoadMeshCodec = () => Promise<MeshCodec>
export declare const loadMeshCodec: LoadMeshCodec

// =====================================================================
// 3. SCENE
// =====================================================================
// Imperative, and outside any reactive system.
//
// Solid signals publish intent; they never own GPU state. Reactive code
// driving buffer uploads is how frame budgets get destroyed.

export interface Scene {
  /** Uploads a mesh and returns the drawable, replacing any existing
   *  drawable for the same body. */
  upload(body: BodyId, buffer: ArrayBuffer): Drawable
  remove(body: BodyId): void
  clear(): void

  readonly camera: Camera
  readonly highlight: HighlightState
  readonly drawables: ReadonlyMap<BodyId, Drawable>

  /** Draws one frame. Called from requestAnimationFrame. */
  render(): void
  resize(width: number, height: number, devicePixelRatio: number): void
  dispose(): void
}

export interface Drawable {
  readonly body: BodyId
  readonly bounds: BoundingBox
  readonly triangleCount: number
  readonly transform: Matrix4
  visible: boolean
  appearance: Appearance
}

export interface Appearance {
  readonly color: Vector3
  readonly metallic: number
  readonly roughness: number
  readonly opacity: number
  /** Draws the topological edges over the shaded surface. */
  readonly showEdges: boolean
}

// =====================================================================
// 4. CAMERA
// =====================================================================

export interface Camera {
  readonly position: Vector3
  readonly target: Vector3
  readonly up: Vector3
  readonly projection: Projection

  orbit(deltaAzimuth: number, deltaElevation: number): void
  pan(deltaX: number, deltaY: number): void
  dolly(delta: number): void
  /** Frames the given bounds, or the whole scene when omitted. */
  fit(bounds?: BoundingBox): void
  /** Standard views. Animates unless `immediate`. */
  viewFrom(direction: StandardView, immediate?: boolean): void
}

export type Projection =
  | { readonly kind: "perspective"; readonly fieldOfView: number; readonly near: number; readonly far: number }
  | { readonly kind: "orthographic"; readonly height: number; readonly near: number; readonly far: number }

export type StandardView =
  | "front" | "back" | "left" | "right" | "top" | "bottom" | "isometric"

// =====================================================================
// 5. PICKING
// =====================================================================
// Resolves a screen position to a topological entity. This is what makes
// selector fields in the panel work at all.
//
// WebGPU: a compute shader walks the hierarchy.
// WebGL2: an auxiliary render target encodes entity ids as colour.
// Both paths return the same type.

export interface PickRequest {
  readonly point: Vector2 // in CSS pixels
  /**
   * What the active panel field accepts. Nothing else is hit-tested,
   * which is why a face-only step cannot select an edge by accident.
   */
  readonly accepts: readonly PickKind[]
  /** Radius in pixels. Edges and vertices need a few pixels of slack. */
  readonly tolerance: number
}

export type PickKind = "body" | "face" | "edge" | "vertex"

export interface PickResult {
  readonly entity: EntityId
  readonly kind: PickKind
  readonly body: BodyId
  /** Where the ray met the surface, in world space. */
  readonly point: Vector3
  readonly distance: number
}

export type Pick = (scene: Scene, request: PickRequest) => PickResult | null
/** Rubber-band selection: everything inside the rectangle. */
export type PickRegion = (
  scene: Scene,
  from: Vector2,
  to: Vector2,
  accepts: readonly PickKind[],
) => readonly PickResult[]

export declare const pick: Pick
export declare const pickRegion: PickRegion

// =====================================================================
// 6. HIGHLIGHTING
// =====================================================================
// Three independent layers, because they answer different questions:
// what is under the cursor, what is chosen, and what the panel is asking
// for right now.

export interface HighlightState {
  /** Under the cursor. Cleared on every pointer move. */
  hovered: EntityId | null
  /** Chosen for the active panel field. */
  selected: ReadonlySet<EntityId>
  /** Valid candidates for the active field; everything else dims. */
  candidates: ReadonlySet<EntityId> | null
  /** Failed a validation rule; drawn in the error colour. */
  invalid: ReadonlySet<EntityId>
}

// =====================================================================
// 7. PREVIEW
// =====================================================================
// Ghost geometry for a command that has not been committed. Driven by
// `preview: true` on a step transition: hovering "Symmetric" shows the
// result before the click.
//
// The server computes it at a coarser tolerance and marks it throwaway,
// so it never enters the feature tree and never reaches git.

export interface Preview {
  show(buffer: ArrayBuffer): void
  hide(): void
  readonly visible: boolean
}

// =====================================================================
// 8. VIEWPORT HANDLES
// =====================================================================
// Draggable gizmos wired to `draggable` on an expression field: the
// arrow that sets extrude distance is this, not a bespoke component.

export interface Handle {
  readonly field: string // the panel field it edits
  readonly axis: Vector3
  readonly origin: Vector3
  readonly kind: HandleKind
}

export type HandleKind = "arrow" | "ring" | "plane" | "point"

/** Emitted while dragging. The panel converts it into an expression. */
export interface HandleDrag {
  readonly field: string
  readonly value: number // millimeters or radians
  readonly committed: boolean // false while dragging, true on release
}
