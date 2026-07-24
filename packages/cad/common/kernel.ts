// =====================================================================
// src/common/kernel.ts
//
// Core abstractions shared by every feature: the common denominator
// between OCCT (today) and Parasolid (later).
//
// Nothing here mentions features, steps, or panels.
// =====================================================================

// =====================================================================
// 1. OPAQUE HANDLES
// =====================================================================
// Numbers at runtime — the same u32 that crosses the N-API boundary —
// but distinct to the compiler. Passing a FaceId where an EdgeId is
// expected will not compile.
//
// Kernel objects (TopoDS_Shape and friends) NEVER cross the boundary.

declare const brand: unique symbol
type Brand<T, B> = T & { readonly [brand]: B }

export type BodyId = Brand<number, "body">
export type FaceId = Brand<number, "face">
export type EdgeId = Brand<number, "edge">
export type VertexId = Brand<number, "vertex">
export type SketchId = Brand<number, "sketch">
export type EntityId = BodyId | FaceId | EdgeId | VertexId

// =====================================================================
// 2. GEOMETRY
// =====================================================================
// Tuples rather than classes: directly serializable, zero-copy into a
// Float64Array. Internal units are millimeters and radians, in a
// right-handed system with Z up.

export type Vector2 = readonly [x: number, y: number]
export type Vector3 = readonly [x: number, y: number, z: number]
export type Matrix4 = readonly number[] & { readonly length: 16 }

export interface Axis {
  readonly origin: Vector3
  readonly direction: Vector3
}

export interface BoundingBox {
  readonly minimum: Vector3
  readonly maximum: Vector3
}

export const LINEAR_TOLERANCE = 1e-6
export const ANGULAR_TOLERANCE = 1e-9

export type GeometryType =
  | "line" | "circle" | "ellipse" | "spline"
  | "plane" | "cylinder" | "cone" | "sphere" | "torus"

// =====================================================================
// 3. EXPRESSIONS
// =====================================================================
// Values are EXPRESSIONS, not numbers. `millimeters`${outerDiameter} /
// 2`` produces a syntax tree that goes into git and is re-evaluated on
// every regeneration, so the relationship survives: `outerDiameter / 2`
// never collapses into `60`. Without this the model is not parametric
// at all.
//
// The tree also feeds the dependency graph — it is how we know that a
// feature depends on the variable `wallThickness`.

export type Dimension = "length" | "angle" | "count" | "scalar"

export interface Expression<D extends Dimension = Dimension> {
  readonly dimension: D
  readonly tree: ExpressionNode
}

export type ExpressionNode =
  | { readonly kind: "literal"; readonly value: number; readonly unit: string }
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "binary"; readonly operator: BinaryOperator; readonly left: ExpressionNode; readonly right: ExpressionNode }
  | { readonly kind: "negate"; readonly operand: ExpressionNode }
  | { readonly kind: "call"; readonly callee: ExpressionFunction; readonly parameters: readonly ExpressionNode[] }
  | { readonly kind: "measurement"; readonly of: MeasurementReference }

export type BinaryOperator = "+" | "-" | "*" | "/" | "^"

export type ExpressionFunction =
  | "sine" | "cosine" | "tangent"
  | "arc-sine" | "arc-cosine" | "arc-tangent" | "arc-tangent-2"
  | "square-root" | "absolute" | "minimum" | "maximum"
  | "floor" | "ceiling" | "round"

export type Length = Expression<"length">
export type Angle = Expression<"angle">
export type Count = Expression<"count">
export type Scalar = Expression<"scalar">
export type Point2 = readonly [Length, Length]

// --- template tags ----------------------------------------------------
// These capture variables BY REFERENCE and validate dimensions while
// parsing:
//
//   millimeters`${outerDiameter} + ${angle}` -> error: length plus angle
//   millimeters`${outerDiameter} * ${wall}`  -> error: length times length is an area
//   millimeters`${outerDiameter} * 2`        -> fine
//   millimeters`${radius} * sine(${theta})`  -> fine

export type LengthTag = (strings: TemplateStringsArray, ...values: readonly Interpolatable[]) => Length
export type AngleTag = (strings: TemplateStringsArray, ...values: readonly Interpolatable[]) => Angle
export type CountTag = (strings: TemplateStringsArray, ...values: readonly Interpolatable[]) => Count

export declare const millimeters: LengthTag
export declare const centimeters: LengthTag
export declare const inches: LengthTag
export declare const degrees: AngleTag
export declare const radians: AngleTag
export declare const quantity: CountTag

export type Interpolatable = Expression | number | Measurement

// --- measurements: existing geometry as expression input --------------
// Lets you say "wall thickness is ten percent of the measured bore
// diameter" and keep the dependency live across regenerations.

export type MeasurementReference =
  | { readonly kind: "face-area"; readonly face: FaceId }
  | { readonly kind: "edge-length"; readonly edge: EdgeId }
  | { readonly kind: "body-volume"; readonly body: BodyId }
  | { readonly kind: "bounding-extent"; readonly body: BodyId; readonly axis: "x" | "y" | "z" }
  | { readonly kind: "separation"; readonly first: EntityId; readonly second: EntityId }

export interface Measurement {
  readonly reference: MeasurementReference
}

export type MakeMeasurement = (reference: MeasurementReference) => Measurement
export declare const measurement: MakeMeasurement

export interface ExpressionScope {
  resolve(name: string): number
}

export type EvaluateExpression = <D extends Dimension>(
  expression: Expression<D>,
  scope: ExpressionScope,
) => number
export declare const evaluateExpression: EvaluateExpression

/** Every variable the tree names; feeds the regeneration graph. */
export type ExpressionDependencies = (expression: Expression) => ReadonlySet<string>
export declare const expressionDependencies: ExpressionDependencies

// =====================================================================
// 4. CAPABILITIES
// =====================================================================
// The common denominator is not one interface with forty methods — it
// is a set of named capabilities the kernel advertises.
//
// Each feature declares what it requires. A missing capability fails AT
// STARTUP, by name, rather than halfway through a user's model. That is
// what makes "OCCT today, Parasolid tomorrow" an honest claim.

export type CapabilityId =
  | "sketch.region" | "sketch.offset-2d"
  | "solid.extrude" | "solid.revolve" | "solid.sweep" | "solid.loft"
  | "boolean.union" | "boolean.subtract" | "boolean.intersect"
  | "local.fillet" | "local.fillet.variable"
  | "local.chamfer" | "local.taper" | "local.shell" | "local.thicken"
  | "transform.translate" | "transform.rotate" | "transform.mirror" | "transform.scale"
  | "query.bounding-box" | "query.mass" | "query.area" | "query.normal"
  | "query.curvature" | "query.topology" | "query.separation"
  | "query.inertia" | "query.interference"
  | "mesh.tessellate"

/** Guaranteed by any kernel: the core of the contract. */
export const BASE_CAPABILITIES = [
  "sketch.region",
  "solid.extrude", "solid.revolve", "solid.sweep", "solid.loft",
  "boolean.union", "boolean.subtract", "boolean.intersect",
  "local.fillet", "local.chamfer", "local.taper", "local.shell",
  "transform.translate", "transform.rotate", "transform.mirror",
  "query.bounding-box", "query.mass", "query.topology",
  "mesh.tessellate",
] as const satisfies readonly CapabilityId[]

// =====================================================================
// 5. THE KERNEL ADAPTER
// =====================================================================

export interface KernelAdapter {
  readonly name: string // "occt", "parasolid"
  readonly version: string
  readonly capabilities: ReadonlySet<CapabilityId>
  /** One session per user session: isolates live bodies and lets us
   *  discard all of them at once when it expires. */
  openSession(): Promise<KernelSession>
}

/**
 * A native session owning the live bodies.
 *
 * OCCT is not thread-safe across operations on the same shape, so one
 * session means one mutex: operations within a session serialize, while
 * separate sessions run in parallel on the thread pool.
 */
export interface KernelSession {
  invoke<T>(capability: CapabilityId, input: unknown): Promise<KernelResult<T>>
  /** A single binary buffer, handed straight to the socket and the GPU. */
  tessellate(body: BodyId, tolerance: number): Promise<KernelResult<ArrayBuffer>>
  /** EXPLICIT release. Never rely on the garbage collector for native
   *  memory: it is not deterministic, and OCCT holds a great deal of it. */
  release(entities: readonly EntityId[]): Promise<void>
  dispose(): Promise<void>
}

// --- errors as values --------------------------------------------------
// A C++ exception (Standard_Failure) must never escape through N-API: it
// would tear down the process, killing every other session on the
// server. The native side converts it into this.

export type KernelResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KernelError }

export interface KernelError {
  readonly code:
    | "operation-failed"
    | "invalid-input"
    | "unsupported"
    | "timeout"
    | "internal"
  readonly capability: CapabilityId
  readonly message: string
  readonly entities: readonly EntityId[]
}

// =====================================================================
// 6. TOPOLOGICAL IDENTITY
// =====================================================================
// The Achilles heel of every parametric CAD system, and the thing
// CadQuery did not solve. There, equality is OCCT pointer identity, and
// every boolean regenerates all shapes — so a selector like `>Z[-2]`
// can silently pick a different face after a parameter changes. The
// resulting solid is valid and wrong, with no error anywhere.
//
// RULE: identifiers never come from the kernel. We derive a stable name
// from feature identifier, semantic role, and deterministic index.

export interface TopologicalName {
  readonly feature: string // "f7"
  readonly role: string // "side" — declared by the feature
  readonly index: number // deterministic
}

export type FormatTopologicalName = (name: TopologicalName) => string // "f7/side[3]"
export type ParseTopologicalName = (text: string) => TopologicalName

export declare const formatTopologicalName: FormatTopologicalName
export declare const parseTopologicalName: ParseTopologicalName

export interface TopologicalMap {
  resolve(name: TopologicalName): EntityId | null
  nameOf(entity: EntityId): TopologicalName | null
  /** Proximity fallback for when the topology genuinely changed. */
  rematch(name: TopologicalName, candidates: readonly EntityId[]): EntityId | null
}

// =====================================================================
// 7. MESH
// =====================================================================
// Packed little-endian binary layout. ONE format, THREE consumers:
// native code, the socket, and the GPU buffer — with no
// re-serialization anywhere along the way.
//
//   header:     u32 vertexCount, u32 triangleCount, u32 faceGroupCount
//   positions:  f32 * 3 * vertexCount
//   normals:    f32 * 3 * vertexCount
//   indices:    u32 * 3 * triangleCount
//   faceGroups: (u32 faceId, u32 firstTriangle, u32 triangleCount) * n
//
// The face groups are what make picking possible: triangle to FaceId.

export interface MeshHeader {
  readonly vertexCount: number
  readonly triangleCount: number
  readonly faceGroupCount: number
}

export interface FaceGroup {
  readonly face: FaceId
  readonly firstTriangle: number
  readonly triangleCount: number
}

export type ReadMeshHeader = (buffer: ArrayBuffer) => MeshHeader
export type ReadFaceGroups = (buffer: ArrayBuffer) => readonly FaceGroup[]
export type FaceOfTriangle = (buffer: ArrayBuffer, triangle: number) => FaceId

export declare const readMeshHeader: ReadMeshHeader
export declare const readFaceGroups: ReadFaceGroups
export declare const faceOfTriangle: FaceOfTriangle

// =====================================================================
// 8. VALIDATION
// =====================================================================

export interface Validator<T> {
  parse(input: unknown): T
}
