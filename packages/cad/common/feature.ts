// =====================================================================
// src/common/feature.ts — FEATURE CONTRACT + PANEL METADATA.
//
// GOAL: zero components per feature. The UI reads this metadata and
// builds the whole panel — for the features that exist today and for
// any future one, including features defined by users.
//
// Each feature.ts exports an ARRAY OF COMMANDS. The panel is DERIVED
// from that array, never written alongside it: two independent
// declarations would diverge on the first change.
//
// The UI implements roughly ten PRIMITIVE WIDGETS (see WidgetKind) and
// never "the extrude panel". A new feature reaches the toolbar without
// a line of UI code. If you ever catch yourself writing
// `if (command.id === "extrude")` in the UI, the metadata is missing
// something — fix it here.
//
// ---------------------------------------------------------------------
// COMPARED WITH ONSHAPE
// ---------------------------------------------------------------------
// In FeatureScript the panel comes from annotations on the parameters:
//
//   annotation { "Feature Type Name" : "Extrude" }
//   export const extrude = defineFeature(function(context, id, definition) {
//       ...
//   }, {
//       annotation { "Name" : "Depth" }
//       isLength(definition.depth, LENGTH_BOUNDS);
//
//       annotation { "Name" : "Draft angle" }
//       isAngle(definition.draftAngle, ANGLE_BOUNDS);
//   });
//
// That is a FLAT LIST of parameters plus visibility predicates
// (`annotation { "Filter" : ... }`, `if (definition.endBound == ...)`).
// Blender, Fusion and SolidWorks all work the same way.
//
// We use a STATE MACHINE instead, and the difference is substantive:
//
//   Onshape: `definition.draftAngle` ALWAYS exists, merely hidden, and
//            the feature body must check whether it is relevant.
//   Linen:   the field exists in neither the step nor the type until it
//            becomes relevant.
//
// What follows from that:
//
//   1. No optional that is really a conditional — the reason HoleInput
//      has no `counterboreDiameter?: number`.
//   2. Mandatory ordering. Onshape lets you fill fields in any order;
//      we guarantee "counterbore" is chosen BEFORE its diameter is asked
//      for.
//   3. No visibility logic in the UI.
//   4. Undo per step rather than per field.
//
// What we did copy from Onshape: the core idea that the parameter
// definition IS the source of the panel, and declaring the picking
// filter next to the field it belongs to.
// =====================================================================

import type {
  CapabilityId, Dimension, Expression, Vector3, BodyId,
  Validator, KernelSession, EntityId,
} from "./kernel"
import type { Cad, FeatureName, Reference, Selector, VariableScope } from "./api"

// =====================================================================
// 1. PRESENTATION TYPES
// =====================================================================

export type ToolbarGroup =
  | "sketch" | "create" | "modify" | "pattern" | "assemble" | "measure"

export type IconId = string

export type DragAxis = "normal" | "radial" | "axial" | "free"

export type EntityKind = "body" | "face" | "edge" | "vertex" | "region" | "draft"

export type SelectorFilter =
  | { readonly kind: "planar-only" }
  | { readonly kind: "circular-only" }
  | { readonly kind: "geometry-type"; readonly types: readonly string[] }
  /** Only entities belonging to the body chosen in another field. */
  | { readonly kind: "same-body-as"; readonly field: string }

/** The complete widget set. Deliberately closed: a feature that needs
 *  an eleventh widget is asking for a special case, and special cases
 *  are what this design exists to prevent. */
export type WidgetKind =
  | "number-with-unit"
  | "checkbox"
  | "button-group"
  | "dropdown"
  | "viewport-picker"
  | "direction-picker"
  | "plane-picker"
  | "feature-list"
  | "point-list"
  | "grid"

// =====================================================================
// 2. COMMAND
// =====================================================================
// The unit every feature file exports. Pure data: serializable,
// versionable, inspectable. No closures, no live references.

export interface CommandDefinition<Input = unknown, Output = BodyId> {
  /** Unique within the feature. Becomes the key in git and the registry. */
  readonly id: string
  readonly label: string
  readonly icon: IconId
  readonly group: ToolbarGroup
  readonly shortcut: string | null
  readonly help: string | null

  /** Topological roles produced; feeds `created(reference, role)`. */
  readonly roles: readonly string[]
  readonly requires: readonly CapabilityId[]

  /** The state machine: single source of the panel and of the order in
   *  which the API must be written. */
  readonly steps: readonly CommandStep[]

  readonly schema: Validator<Input>
  readonly version: number
  readonly migrations: Migrations<Input>

  /** Runs the operation against already-validated input. */
  execute(input: Input, context: FeatureContext): Promise<Output>

  /**
   * Checks that referenced entities belong to the target BEFORE the
   * native call. CadQuery carries a live `TODO: we segfault` for
   * skipping this; across our N-API boundary it would take down the
   * process and every other session with it.
   */
  validate?(input: Input, context: FeatureContext): Promise<readonly string[]>
}

/** Migrations keyed by source version. Older models regenerate with the
 *  older semantics instead of breaking. */
export type Migrations<Input> = ReadonlyMap<number, (stored: unknown) => Input>

// =====================================================================
// 3. STEP
// =====================================================================
// A step declares the fields it exposes and where it can go next. The
// builder interfaces in each api.ts express the same machine to the
// compiler; `validateFeature` checks the two agree.

export interface CommandStep {
  readonly id: string
  readonly label: string
  readonly help: string | null
  /** The fields shown in THIS step, and only those. This is what
   *  removes conditional visibility logic from the UI entirely. */
  readonly fields: readonly FieldDefinition[]
  /** User choices. Empty means terminal: the command can be built. */
  readonly transitions: readonly StepTransition[]
  readonly optional: boolean
  /** Once filled, advance without an explicit click. Good for
   *  mutually exclusive choices. */
  readonly autoAdvance: boolean
}

export interface StepTransition {
  readonly id: string
  readonly label: string
  /** Empty string means terminal. */
  readonly to: string
  readonly icon: IconId | null
  /** Preview in the viewport on hover, without committing. */
  readonly preview: boolean
  /** The union variant this transition produces, if any. Ties the
   *  user's choice to the `kind` of the persisted input. */
  readonly variant: string | null
}

// =====================================================================
// 4. FIELDS
// =====================================================================
// A neutral description of a parameter: neither a widget nor a
// TypeScript type. `widgetFor` maps it to a primitive; the schema
// validates it.

interface FieldBase {
  readonly name: string
  readonly label: string
  readonly help: string | null
  /** False means the step will not advance until this is filled. */
  readonly optional: boolean
}

export interface ExpressionField extends FieldBase {
  readonly kind: "expression"
  readonly dimension: Dimension
  readonly default: Expression | null
  readonly minimum: number | null
  readonly maximum: number | null
  readonly increment: number | null
  /** Dragging this handle in the viewport edits the field. */
  readonly draggable: DragAxis | null
}

export interface BooleanField extends FieldBase {
  readonly kind: "boolean"
  readonly default: boolean
}

export interface ChoiceField extends FieldBase {
  readonly kind: "choice"
  readonly options: readonly ChoiceOption[]
  readonly default: string | null
}

export interface ChoiceOption {
  readonly value: string
  readonly label: string
  readonly icon: IconId | null
}

/** Geometry picking in the viewport. The most important widget: it
 *  decides what is clickable and how many items are accepted, which is
 *  why an "up to face" step cannot pick an edge by accident. */
export interface SelectorField extends FieldBase {
  readonly kind: "selector"
  readonly accepts: readonly EntityKind[]
  readonly cardinality: "one" | "many"
  readonly filter: SelectorFilter | null
  /** Focus on entering the step, so the user can click the part
   *  straight away. */
  readonly autoFocus: boolean
}

export interface DirectionField extends FieldBase {
  readonly kind: "direction"
  readonly default: Vector3 | null
  readonly allowPick: boolean
  readonly allowFlip: boolean
}

export interface PlaneField extends FieldBase {
  readonly kind: "plane"
  readonly allowFace: boolean
  readonly allowOffset: boolean
}

/** A reference to another feature: profile, path, loft sections. */
export interface ReferenceField extends FieldBase {
  readonly kind: "reference"
  readonly of: "draft" | "body" | "feature"
  readonly cardinality: "one" | "many"
  /** Minimum count: a loft requires two sections. */
  readonly minimumItems: number | null
}

/** A list of two-dimensional points on a face, such as hole positions. */
export interface PointListField extends FieldBase {
  readonly kind: "point-list"
  /** Name of the selector field that defines the reference plane. */
  readonly onFace: string
  readonly minimumItems: number
}

/** An editable grid: variable fillet stops, configuration tables. */
export interface TableField extends FieldBase {
  readonly kind: "table"
  readonly columns: readonly TableColumn[]
  readonly minimumRows: number
}

export interface TableColumn {
  readonly name: string
  readonly label: string
  readonly dimension: Dimension | "text"
}

export type FieldDefinition =
  | ExpressionField
  | BooleanField
  | ChoiceField
  | SelectorField
  | DirectionField
  | PlaneField
  | ReferenceField
  | PointListField
  | TableField

// =====================================================================
// 5. WHAT EACH FEATURE FILE EXPORTS
// =====================================================================
// An array. Most features carry a single command; a pattern feature
// would carry three (linear, circular, along-path) sharing one
// execution path.

export interface FeatureApi {
  readonly name: FeatureName
  readonly commands: readonly CommandDefinition<never, never>[]
  /**
   * Builds the typed entry point placed on the `cad` facade.
   *
   * Only capture the context here. Do not run geometry and do not call
   * context.cad.* — that is a CREATION cycle, which the container
   * rejects with the full path in the message.
   */
  create(context: FeatureContext): unknown
}

/**
 * The context injected into every feature. `cad` is the container's
 * lazy proxy: it is how one feature uses another without a value
 * import, which is what keeps the module graph acyclic.
 */
export interface FeatureContext {
  readonly cad: Cad
  readonly variables: VariableScope
  capability(id: CapabilityId): Capability
  evaluate<D extends Dimension>(expression: Expression<D>): number
  emit<Output>(command: unknown): Reference<Output>
  session(): KernelSession
  /** Guards the segfault path described on CommandDefinition.validate. */
  entityBelongsTo(entity: Selector<EntityId>, body: Reference<BodyId>): Promise<boolean>
}

export interface Capability {
  invoke<T>(input: unknown): Promise<T>
}

// =====================================================================
// 6. THE BRIDGE: commands to panel
// =====================================================================
// Mechanical derivation. The only presentation decisions here are which
// primitive draws each field and how a set of transitions is laid out.

export type WidgetFor = (field: FieldDefinition) => WidgetKind
export declare const widgetFor: WidgetFor

/**
 * Transition layout, chosen by count:
 *   1     single button (straight advance)
 *   2-4   button group
 *   5+    dropdown
 */
export type TransitionLayout = (
  transitions: readonly StepTransition[],
) => "single" | "button-group" | "dropdown"
export declare const transitionLayout: TransitionLayout

/** The whole toolbar, grouped. No hand-maintained list anywhere. */
export type BuildToolbar = (
  features: readonly FeatureApi[],
) => ReadonlyMap<ToolbarGroup, readonly CommandDefinition<never, never>[]>
export declare const buildToolbar: BuildToolbar

// =====================================================================
// 7. VALIDATION — runs in CI, not at runtime
// =====================================================================
// The state machine exists twice: in TypeScript types (the builder
// interfaces) and in data (`steps`). Nothing stops them drifting apart,
// so this catches it before it ships.

export type ValidateFeature = (
  command: CommandDefinition<never, never>,
) => readonly FeatureValidationError[]
export declare const validateFeature: ValidateFeature

export interface FeatureValidationError {
  readonly code:
    | "unreachable-step" // no path from the entry step
    | "dangling-transition" // `to` names a step that does not exist
    | "no-terminal-step" // nothing can ever be built
    | "field-not-in-schema" // declared field the input does not have
    | "schema-field-uncovered" // input field no step ever asks for
    | "duplicate-field" // same name twice along one path
    | "variant-mismatch" // transition variant absent from the union
    | "role-unused" // declared role the execution never produces
  readonly step: string | null
  readonly field: string | null
  readonly message: string
}

// =====================================================================
// 8. PANEL STATE
// =====================================================================

export interface PanelState {
  readonly command: string
  readonly currentStep: string
  /** Steps already walked, so going back does not discard the command. */
  readonly path: readonly string[]
  readonly values: ReadonlyMap<string, unknown>
  readonly canBuild: boolean
  readonly errors: readonly PanelFieldError[]
}

export interface PanelFieldError {
  readonly field: string
  readonly message: string
}

export type BeginCommand = (command: CommandDefinition<never, never>) => PanelState
export type SetField = (state: PanelState, field: string, value: unknown) => PanelState
export type ApplyTransition = (state: PanelState, transition: string) => PanelState
/** Undo per STEP rather than per field. */
export type StepBack = (state: PanelState) => PanelState
/** Only valid when `canBuild`. Produces the serializable input. */
export type FinishCommand = <Input>(
  state: PanelState,
  command: CommandDefinition<Input, never>,
) => Input

export declare const beginCommand: BeginCommand
export declare const setField: SetField
export declare const applyTransition: ApplyTransition
export declare const stepBack: StepBack
export declare const finishCommand: FinishCommand

// =====================================================================
// 9. WHAT THE UI IMPLEMENTS
// =====================================================================
//
// ONCE, for every feature:
//
//   <FeaturePanel command={commandDefinition} />
//     - step navigation      tabs or breadcrumb over `steps`
//     - transition group     buttons or dropdown, per transitionLayout
//     - field renderer       switch over field.kind, via widgetFor:
//
//         expression   -> number-with-unit  (accepts expressions)
//         boolean      -> checkbox
//         choice       -> button-group or dropdown
//         selector     -> viewport-picker
//         direction    -> direction-picker
//         plane        -> plane-picker
//         reference    -> feature-list
//         point-list   -> point-list
//         table        -> grid
//
// Ten widgets. None of them knows what an extrude is.
