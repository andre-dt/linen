// =====================================================================
// src/hud/api.ts — THE PANEL.
//
// Ten primitive widgets and no component per feature. Everything here
// reads `CommandDefinition` from common/feature.ts; nothing in this
// directory knows what an extrude is.
//
// A new feature reaches the toolbar by existing in the preset. If you
// ever find yourself writing `if (command.id === "extrude")` in this
// directory, the metadata is missing something — fix it there.
//
// WHERE THE BOUNDARY IS
// ---------------------
// Solid signals own panel input state: which step, which values, which
// field has focus. They never own GPU state. The viewport is imperative
// and lives outside the reactive graph; the panel publishes intent — a
// picking request, a preview — and the viewer acts on it.
// =====================================================================

import type { EntityId } from "../common/kernel"
import type {
  CommandDefinition, CommandStep, FieldDefinition, StepTransition,
  PanelState, ToolbarGroup, WidgetKind,
} from "../common/feature"
import type { PickKind, PickResult, HandleDrag, Scene } from "../viewer/api"
import type { Client, FeatureSummary, Diagnostic } from "../protocol/api"

// =====================================================================
// 1. PANEL SESSION
// =====================================================================
// One in-flight command: created when a toolbar entry is clicked,
// destroyed on commit or cancel.

export interface PanelSession {
  readonly definition: CommandDefinition<never, never>
  readonly state: PanelState
  readonly step: CommandStep

  setField(field: string, value: unknown): void
  transition(id: string): void
  /** Undo per STEP, not per field: the whole point of the state machine. */
  back(): void
  /** Only valid when `state.canBuild`. */
  commit(): Promise<void>
  cancel(): void

  /** Which field receives the next viewport pick. */
  readonly activeField: string | null
  focusField(field: string): void
  /** Called by the viewport on a successful pick. */
  acceptPick(result: PickResult): void
  /** Called while a viewport handle is being dragged. */
  acceptDrag(drag: HandleDrag): void
}

export type OpenPanel = (
  definition: CommandDefinition<never, never>,
  client: Client,
  scene: Scene,
) => PanelSession
export declare const openPanel: OpenPanel

// =====================================================================
// 2. PICKING, DRIVEN BY THE ACTIVE FIELD
// =====================================================================
// The selector field declares what it accepts, so an "up to face" step
// simply cannot pick an edge. This is metadata doing the work that would
// otherwise be per-feature UI logic.

export interface PickingContext {
  readonly accepts: readonly PickKind[]
  readonly cardinality: "one" | "many"
  /** Everything else dims. Resolved server-side via `selector.resolve`,
   *  so the client never re-implements selection semantics. */
  readonly candidates: ReadonlySet<EntityId> | null
  readonly tolerance: number
}

/** Derived from the active field. There is no other source. */
export type PickingContextFor = (session: PanelSession) => PickingContext | null
export declare const pickingContextFor: PickingContextFor

// =====================================================================
// 3. PREVIEW
// =====================================================================
// A transition with `preview: true` shows the result on hover, before
// the click. The server computes it coarsely and throws it away.
//
// Generation numbers matter: hovering across four options fires four
// previews, and only the newest may reach the screen.

export interface PreviewController {
  onHoverTransition(transition: StepTransition): void
  onLeaveTransition(): void
  /** Live preview while a value changes, debounced. */
  onFieldChange(field: string, value: unknown): void
}

// =====================================================================
// 4. WIDGETS
// =====================================================================
// The complete set. Deliberately closed: a feature needing an eleventh
// widget is asking for a special case, and special cases are what this
// design exists to prevent.

export interface WidgetProps<F extends FieldDefinition = FieldDefinition> {
  readonly field: F
  readonly value: unknown
  readonly error: string | null
  readonly onChange: (value: unknown) => void
  readonly onFocus: () => void
}

/** Every widget takes WidgetProps and nothing else. */
export type Widget = (props: WidgetProps) => unknown

export interface WidgetRegistry {
  readonly numberWithUnit: Widget
  readonly checkbox: Widget
  readonly buttonGroup: Widget
  readonly dropdown: Widget
  readonly viewportPicker: Widget
  readonly directionPicker: Widget
  readonly planePicker: Widget
  readonly featureList: Widget
  readonly pointList: Widget
  readonly grid: Widget
}

export type ResolveWidget = (registry: WidgetRegistry, kind: WidgetKind) => Widget
export declare const resolveWidget: ResolveWidget

// =====================================================================
// 5. THE EXPRESSION EDITOR
// =====================================================================
// The `number-with-unit` widget is not a number input. It accepts an
// expression, which is the reason the model is parametric at all: typing
// `outerDiameter / 2` stores the relationship, not `60`.

export interface ExpressionEditorState {
  /** Exactly what the user typed, kept verbatim so a round trip through
   *  the panel never rewrites their formula. */
  readonly text: string
  /** Evaluated result, shown greyed beside the input. */
  readonly evaluated: number | null
  readonly unit: string
  /** Parse or dimension error, straight from the tag. */
  readonly error: string | null
  /** Variables in scope, for autocomplete. */
  readonly suggestions: readonly string[]
}

// =====================================================================
// 6. TOOLBAR
// =====================================================================
// Derived from the preset and grouped by `group`. Never a hand-written
// list — that would be one more thing to forget when adding a feature.

export interface ToolbarEntry {
  readonly definition: CommandDefinition<never, never>
  /** False when the connected kernel lacks a required capability: the
   *  entry greys out with a reason, rather than failing mid-command. */
  readonly available: boolean
  readonly unavailableReason: string | null
}

export type BuildToolbarModel = (
  definitions: readonly CommandDefinition<never, never>[],
  capabilities: ReadonlySet<string>,
) => ReadonlyMap<ToolbarGroup, readonly ToolbarEntry[]>
export declare const buildToolbarModel: BuildToolbarModel

// =====================================================================
// 7. FEATURE TREE
// =====================================================================

export interface FeatureTreeModel {
  readonly features: readonly FeatureTreeItem[]
  readonly rollbackIndex: number

  select(feature: string): void
  /** Opens the panel pre-filled for editing. */
  edit(feature: string): void
  toggleSuppress(feature: string): void
  remove(feature: string): void
  reorder(feature: string, toIndex: number): void
  rollbackTo(index: number): void
}

export interface FeatureTreeItem {
  readonly summary: FeatureSummary
  readonly icon: string
  /** Inactive because it sits below the rollback marker. */
  readonly belowRollback: boolean
  readonly diagnostics: readonly Diagnostic[]
}

// =====================================================================
// 8. VARIABLE PANEL
// =====================================================================
// Where parametric editing actually happens: change one value and the
// whole downstream graph regenerates.

export interface VariablePanelModel {
  readonly variables: readonly VariableRow[]
  set(name: string, text: string): Promise<void>
  add(name: string, text: string, kind: VariableKind): Promise<void>
  remove(name: string): Promise<void>
}

export interface VariableRow {
  readonly name: string
  readonly kind: VariableKind
  readonly text: string // the expression as written
  readonly evaluated: number | boolean | string
  readonly unit: string | null
  /** Derived variables are read-only. */
  readonly editable: boolean
  /** Features that would regenerate if this changed. */
  readonly dependents: readonly string[]
  readonly error: string | null
}

export type VariableKind = "length" | "angle" | "count" | "flag" | "choice" | "derived"

// =====================================================================
// 9. LAYOUT
// =====================================================================
// The panel floats over the canvas. The canvas fills the window and
// nothing reflows it, so resizing never triggers a re-tessellation.
//
//   +--------------------------------------------------+
//   | toolbar                                          |
//   +----------+---------------------------------------+
//   | feature  |                                       |
//   | tree     |            canvas (3D)                |
//   |          |                                       |
//   | vars     |          +-----------------+          |
//   |          |          | command panel   |          |
//   |          |          | (floating)      |          |
//   +----------+----------+-----------------+----------+
//   | status: diagnostics, regeneration time           |
//   +--------------------------------------------------+

export interface HudLayout {
  readonly toolbarHeight: number
  readonly sidebarWidth: number
  readonly statusHeight: number
  readonly panelPosition: { readonly x: number; readonly y: number }
  readonly sidebarCollapsed: boolean
}

export interface Hud {
  readonly toolbar: ReadonlyMap<ToolbarGroup, readonly ToolbarEntry[]>
  readonly tree: FeatureTreeModel
  readonly variables: VariablePanelModel
  readonly layout: HudLayout
  /** Null when no command is in flight. */
  readonly panel: PanelSession | null

  beginCommand(definition: CommandDefinition<never, never>): void
  /** Keyboard dispatch, from CommandDefinition.shortcut. */
  handleShortcut(key: string): boolean
}

export type CreateHud = (
  definitions: readonly CommandDefinition<never, never>[],
  client: Client,
  scene: Scene,
) => Hud
export declare const createHud: CreateHud
