// =====================================================================
// src/common/api.ts
//
// API types shared by every feature: references, selectors, commands,
// variables, and the `Cad` facade.
//
// Imports types from ./kernel; kernel never imports from here.
// =====================================================================

import type {
  BodyId, FaceId, EdgeId, VertexId, SketchId, EntityId,
  Vector3, Axis, Length, Angle, Count,
  Expression, Dimension, GeometryType,
} from "./kernel"

export type { BodyId, FaceId, EdgeId, VertexId, SketchId, EntityId }

// =====================================================================
// 1. REFERENCES
// =====================================================================
// A `Reference` is a PROMISE of a result, not the result itself. It
// lets the whole tree be written declaratively and executed only
// afterwards, which is what makes regeneration and git replay possible.

export interface Reference<T> {
  readonly value: T
  readonly producedBy: string // identifier of the producing feature
}

// =====================================================================
// 2. SELECTORS
// =====================================================================
// The typed answer to CadQuery's string mini-language.
//
// Inherited from them: RE-DERIVABLE predicates ("the face with the
// greatest Z") rather than indices ("face #12"). Indices are the origin
// of the topological naming problem in FreeCAD.
//
// Corrected: cardinality is part of the type, so an unexpected count is
// an ERROR rather than a silent result — their `>Z[1]` returns the
// second *cluster* of coplanar faces, and elements whose key throws are
// dropped silently, shifting every index after them. Nothing here is
// ever silently excluded.

export type Cardinality = "one" | "many" | "optional"

export interface Selector<T extends EntityId> {
  readonly of: "body" | "face" | "edge" | "vertex"
  readonly cardinality: Cardinality
  readonly node: SelectorNode // serializable: goes into git
}

export type SelectorNode =
  | { readonly kind: "all"; readonly source: Reference<BodyId> }
  | { readonly kind: "created"; readonly feature: string; readonly role: string }
  | { readonly kind: "extreme"; readonly from: SelectorNode; readonly direction: Vector3; readonly which: "maximum" | "minimum" }
  | { readonly kind: "parallel"; readonly from: SelectorNode; readonly direction: Vector3 }
  | { readonly kind: "perpendicular"; readonly from: SelectorNode; readonly direction: Vector3 }
  | { readonly kind: "by-area"; readonly from: SelectorNode; readonly rank: Rank }
  | { readonly kind: "by-radius"; readonly from: SelectorNode; readonly predicate: RangePredicate | Rank }
  | { readonly kind: "by-length"; readonly from: SelectorNode; readonly predicate: RangePredicate }
  | { readonly kind: "geometry-type"; readonly from: SelectorNode; readonly type: GeometryType }
  | { readonly kind: "edges-from"; readonly faces: SelectorNode }
  | { readonly kind: "faces-from"; readonly edges: SelectorNode }
  | { readonly kind: "vertices-from"; readonly edges: SelectorNode }
  | { readonly kind: "adjacent"; readonly faces: SelectorNode }
  | { readonly kind: "all-of"; readonly items: readonly SelectorNode[] }
  | { readonly kind: "any-of"; readonly items: readonly SelectorNode[] }
  | { readonly kind: "complement"; readonly item: SelectorNode }
  | { readonly kind: "difference"; readonly left: SelectorNode; readonly right: SelectorNode }
  | { readonly kind: "cardinality"; readonly item: SelectorNode; readonly expected: Cardinality }

export type Rank = "largest" | "smallest" | number

export interface RangePredicate {
  readonly minimum: Length | null
  readonly maximum: Length | null
}

// --- sources -----------------------------------------------------------
export type FacesOf = (body: Reference<BodyId>) => Selector<FaceId>
export type EdgesOf = (body: Reference<BodyId>) => Selector<EdgeId>
export type VerticesOf = (body: Reference<BodyId>) => Selector<VertexId>

export declare const facesOf: FacesOf
export declare const edgesOf: EdgesOf
export declare const verticesOf: VerticesOf

/**
 * The strongest selector: the entity THIS feature created, addressed by
 * its declared semantic role. It depends on no geometry whatsoever, so
 * it cannot break when parameters change. Prefer it wherever the entity
 * comes from a feature of your own.
 *
 *   created<FaceId>(disc, "end")
 */
export type Created = <T extends EntityId>(
  feature: Reference<BodyId>,
  role: string,
) => Selector<T>
export declare const created: Created

// --- directional (CadQuery: >Z, <X, |Z, #Z) ---------------------------
export type Extreme = <T extends FaceId | EdgeId>(
  from: Selector<T>,
  direction: Vector3,
  which: "maximum" | "minimum",
) => Selector<T>

export type DirectionalFilter = <T extends FaceId | EdgeId>(
  from: Selector<T>,
  direction: Vector3,
) => Selector<T>

export declare const extreme: Extreme
export declare const parallelTo: DirectionalFilter
export declare const perpendicularTo: DirectionalFilter

// --- by intrinsic property --------------------------------------------
// Area, radius and length survive orientation changes far better than
// directional selectors do. CadQuery added AreaNthSelector and
// RadiusNthSelector late; here they are present from the start.
export type ByArea = (from: Selector<FaceId>, rank: Rank) => Selector<FaceId>
export type ByRadius = (from: Selector<EdgeId>, predicate: RangePredicate | Rank) => Selector<EdgeId>
export type ByLength = (from: Selector<EdgeId>, predicate: RangePredicate) => Selector<EdgeId>
export type OfType = <T extends FaceId | EdgeId>(from: Selector<T>, type: GeometryType) => Selector<T>
export type CircularEdges = (from: Selector<EdgeId>) => Selector<EdgeId>
export type PlanarFaces = (from: Selector<FaceId>) => Selector<FaceId>

export declare const byArea: ByArea
export declare const byRadius: ByRadius
export declare const byLength: ByLength
export declare const ofType: OfType
export declare const circular: CircularEdges
export declare const planar: PlanarFaces

// --- relational: the most robust --------------------------------------
// These express a RELATIONSHIP rather than a coordinate. CadQuery's
// ancestors and siblings are its most reliable selectors for exactly
// that reason; here they are first-class primitives.
export type EdgesFrom = (faces: Selector<FaceId>) => Selector<EdgeId>
export type FacesFrom = (edges: Selector<EdgeId>) => Selector<FaceId>
export type VerticesFrom = (edges: Selector<EdgeId>) => Selector<VertexId>
export type AdjacentTo = (faces: Selector<FaceId>) => Selector<FaceId>

export declare const edgesFrom: EdgesFrom
export declare const facesFrom: FacesFrom
export declare const verticesFrom: VerticesFrom
export declare const adjacentTo: AdjacentTo

// --- combinators (CadQuery's and/or/not/exc, but typed) ---------------
// Same expressiveness as their string grammar, with autocomplete and
// compile-time checking instead of a parser.
export type Combinator = <T extends EntityId>(...selectors: Selector<T>[]) => Selector<T>
export type Complement = <T extends EntityId>(selector: Selector<T>) => Selector<T>
export type Difference = <T extends EntityId>(left: Selector<T>, right: Selector<T>) => Selector<T>

export declare const allOf: Combinator
export declare const anyOf: Combinator
export declare const complement: Complement
export declare const difference: Difference

// --- cardinality: a checked assertion ---------------------------------
export type ExactlyOne = <T extends EntityId>(selector: Selector<T>) => Selector<T> & { cardinality: "one" }
export type Many = <T extends EntityId>(selector: Selector<T>) => Selector<T> & { cardinality: "many" }

export declare const exactlyOne: ExactlyOne
export declare const many: Many

// =====================================================================
// 3. PLANES
// =====================================================================

export type PlaneReference =
  | { readonly kind: "standard"; readonly name: "xy" | "xz" | "yz" }
  | { readonly kind: "face"; readonly face: Selector<FaceId> }
  | { readonly kind: "offset"; readonly from: PlaneReference; readonly distance: Length }
  | { readonly kind: "angled"; readonly from: PlaneReference; readonly axis: Axis; readonly angle: Angle }

export declare const XY: PlaneReference
export declare const XZ: PlaneReference
export declare const YZ: PlaneReference

// =====================================================================
// 4. COMMANDS
// =====================================================================
// Pure data. The constructor runs nothing, touches no kernel, performs
// no input or output. It is the node in the tree and the line in git.

export interface Command<Input, Output> {
  readonly name: FeatureName
  readonly version: number
  readonly id: string
  readonly input: Input
}

/** Every step chain ends here. `build()` exists only once complete. */
export interface Buildable<Input, Output> {
  build(): Command<Input, Output>
}

/** The mandatory final step of every generating feature. */
export interface CombineStep<Done> {
  asNewBody(): Done
  addTo(target: Reference<BodyId>): Done
  subtractFrom(target: Reference<BodyId>): Done
  intersectWith(target: Reference<BodyId>): Done
}

export type CombineOperation =
  | { readonly kind: "new" }
  | { readonly kind: "add"; readonly target: Reference<BodyId> }
  | { readonly kind: "subtract"; readonly target: Reference<BodyId> }
  | { readonly kind: "intersect"; readonly target: Reference<BodyId> }

// =====================================================================
// 5. VARIABLES
// =====================================================================

export interface VariableScope {
  length(name: string, initial: Length): Length
  angle(name: string, initial: Angle): Angle
  count(name: string, initial: Count): Count
  /** Drives feature suppression and configuration branches. */
  flag(name: string, initial: boolean): Flag
  /** Becomes a dropdown in the panel. */
  choice<const T extends readonly string[]>(name: string, options: T, initial: T[number]): Choice<T[number]>
  /** Not editable; always recomputed from its expression. */
  derived<D extends Dimension>(name: string, expression: Expression<D>): Expression<D>
  /** Configuration table: one row per variant. */
  table<const R extends readonly string[]>(name: string, rows: R): ConfigurationTable<R[number]>
}

export interface Flag {
  readonly kind: "flag"
  readonly name: string
}

export interface Choice<T extends string> {
  readonly kind: "choice"
  readonly name: string
  readonly value: T
}

export interface ConfigurationTable<R extends string> {
  select(row: R): void
  length(column: string): Length
  count(column: string): Count
}

// =====================================================================
// 6. THE FACADE
// =====================================================================
// Declared here, assembled by the container. Lazy proxy resolution
// means cycles between features (bolt reaching for hole) work with no
// manual ordering.
//
// Each feature contributes one entry. The step types live in each
// feature's api.ts and come back here through `import type`, which is
// erased at compile time and therefore cannot form a runtime cycle.

import type { DraftApi } from "../draft/api"
import type { ExtrudeApi } from "../extrude/api"

/** MVP scope. Grows one entry per feature. */
export type FeatureName = "draft" | "extrude"

export interface Cad {
  readonly draft: DraftApi
  readonly extrude: ExtrudeApi
}
