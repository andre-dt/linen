// =====================================================================
// src/draft/feature.ts
//
// IMPLEMENTATION + METADATA: the bridge between api.ts, kernel.ts and
// the HUD.
//
// Drawing is MODAL rather than step-linear — pick a tool, click points,
// keep drawing, finish. So the steps here form a hub: `tools` returns to
// itself after every curve, instead of the straight line an extrude
// follows.
//
// The same metadata drives both shapes. A self-referencing transition
// graph is still a graph, so the generic renderer needs no special case
// for it — which is the point of deriving the panel from data.
// =====================================================================

import { z } from "zod"
import type { SketchId, Validator } from "../common/kernel"
import type { PlaneReference } from "../common/api"
import type {
  CommandDefinition, CommandStep, FeatureApi, FeatureContext, Migrations,
} from "../common/feature"
import { DRAFT_CAPABILITIES, DRAFT_ROLES } from "./kernel"
import { passthrough } from "../common/validate"
import type { DraftInput, DraftStepCurves, DraftApi } from "./api"

// =====================================================================
// STEPS
// =====================================================================

/**
 * The shape a chosen sketch plane takes. Both ways in produce one of
 * these: a datum plane clicked in the canvas, or a planar face.
 *
 * Its job is to fire the step's transition — parsing IS the test, so the
 * step ends the moment the value is well-formed rather than when the user
 * confirms it.
 */
const PLANE_CHOSEN = z.object({
  plane: z.union([
    z.object({
      kind: z.literal("datum"),
      plane: z.string().min(1),
      axes: z.enum(["XY", "XZ", "YZ"]),
    }),
    z.object({ kind: z.literal("face"), face: z.string().min(1) }),
  ]),
})

const steps: readonly CommandStep[] = [
  {
    id: "plane",
    label: "Plane",
    help: "Select a plane or planar face in the canvas.",
    optional: false,
    fields: [
      {
        kind: "plane", name: "plane", label: "Sketch plane",
        allowFace: true, allowOffset: true,
        optional: false, help: null,
      },
    ],
    // DATA-DRIVEN: choosing a plane ends the step. There is nothing else
    // this step gathers and nowhere else it could go, so a "Draw" button
    // would only ask the user to confirm what they just did.
    //
    // Expressed as a SCHEMA rather than a predicate because the test is
    // about SHAPE — the value is a datum reference or a face reference —
    // and a schema says that once instead of saying it as a hand-written
    // check that then drifts from the shape it was checking.
    transitions: [
      {
        id: "next", label: "Draw", to: "tools",
        icon: null, preview: false, variant: null,
        when: { kind: "schema", schema: PLANE_CHOSEN },
      },
    ],
  },
  {
    id: "tools",
    label: "Draw",
    help: null,
    optional: false,
    fields: [
      {
        kind: "boolean", name: "construction", label: "Construction",
        default: false,
        optional: true,
        help: "Guides the solver; never becomes material.",
      },
    ],
    // The hub. Each tool draws, then returns here.
    transitions: [
      { id: "line", label: "Line", to: "draw.line", icon: "line", preview: true, variant: "line", when: null },
      { id: "rectangle", label: "Rectangle", to: "draw.rectangle", icon: "rectangle", preview: true, variant: "rectangle", when: null },
      { id: "circle", label: "Circle", to: "draw.circle", icon: "circle", preview: true, variant: "circle", when: null },
      { id: "arc", label: "Arc", to: "draw.arc", icon: "arc", preview: true, variant: "arc", when: null },
      { id: "spline", label: "Spline", to: "draw.spline", icon: "spline", preview: true, variant: "spline", when: null },
      { id: "polygon", label: "Polygon", to: "draw.polygon", icon: "polygon", preview: true, variant: "polygon", when: null },
      { id: "finish", label: "Finish", to: "", icon: "check", preview: false, variant: null, when: null },
    ],
  },
  {
    id: "draw.line",
    label: "Line",
    help: "Click the start and end points.",
    optional: false,
    fields: [
      {
        kind: "point-list", name: "points", label: "Points",
        onFace: "plane", minimumItems: 2,
        optional: false, help: null,
      },
    ],
    transitions: [
      { id: "continue", label: "Keep drawing", to: "tools", icon: null, preview: false, variant: null, when: null },
    ],
  },
  {
    id: "draw.rectangle",
    label: "Rectangle",
    help: "Click two opposite corners.",
    optional: false,
    fields: [
      {
        kind: "point-list", name: "corners", label: "Corners",
        onFace: "plane", minimumItems: 2,
        optional: false, help: null,
      },
    ],
    transitions: [
      { id: "continue", label: "Keep drawing", to: "tools", icon: null, preview: false, variant: null, when: null },
    ],
  },
  {
    id: "draw.circle",
    label: "Circle",
    help: null,
    optional: false,
    fields: [
      {
        kind: "point-list", name: "center", label: "Center",
        onFace: "plane", minimumItems: 1,
        optional: false, help: null,
      },
      {
        kind: "expression", name: "radius", label: "Radius", dimension: "length",
        default: null, minimum: 0, maximum: null, increment: 1,
        draggable: "radial", // dragging in the viewport edits this
        optional: false, help: null,
      },
    ],
    transitions: [
      { id: "continue", label: "Keep drawing", to: "tools", icon: null, preview: false, variant: null, when: null },
    ],
  },
  {
    id: "draw.arc",
    label: "Arc",
    help: "Click start, end, then a point on the arc.",
    optional: false,
    fields: [
      {
        kind: "point-list", name: "points", label: "Points",
        onFace: "plane", minimumItems: 3,
        optional: false, help: null,
      },
    ],
    transitions: [
      { id: "continue", label: "Keep drawing", to: "tools", icon: null, preview: false, variant: null, when: null },
    ],
  },
  {
    id: "draw.spline",
    label: "Spline",
    help: "Click control points; double-click to end.",
    optional: false,
    fields: [
      {
        kind: "point-list", name: "points", label: "Control points",
        onFace: "plane", minimumItems: 2,
        optional: false, help: null,
      },
      {
        kind: "boolean", name: "closed", label: "Closed",
        default: false, optional: true, help: null,
      },
    ],
    transitions: [
      { id: "continue", label: "Keep drawing", to: "tools", icon: null, preview: false, variant: null, when: null },
    ],
  },
  {
    id: "draw.polygon",
    label: "Polygon",
    help: null,
    optional: false,
    fields: [
      {
        kind: "point-list", name: "center", label: "Center",
        onFace: "plane", minimumItems: 1,
        optional: false, help: null,
      },
      {
        kind: "expression", name: "radius", label: "Radius", dimension: "length",
        default: null, minimum: 0, maximum: null, increment: 1,
        draggable: "radial", optional: false, help: null,
      },
      {
        kind: "expression", name: "sides", label: "Sides", dimension: "count",
        default: null, minimum: 3, maximum: 64, increment: 1,
        draggable: null, optional: false, help: null,
      },
      {
        kind: "choice", name: "fit", label: "Fit",
        options: [
          { value: "inscribed", label: "Inscribed", icon: null },
          { value: "circumscribed", label: "Circumscribed", icon: null },
        ],
        default: "inscribed", optional: false, help: null,
      },
    ],
    transitions: [
      { id: "continue", label: "Keep drawing", to: "tools", icon: null, preview: false, variant: null, when: null },
    ],
  },
]

// =====================================================================
// MIGRATIONS
// =====================================================================

const migrations: Migrations<DraftInput> = new Map()

// =====================================================================
// EXECUTION
// =====================================================================

type ResolveCurves = (input: DraftInput, context: FeatureContext) => object
type MakeDraftBuilder = (context: FeatureContext, plane: PlaneReference) => DraftStepCurves

declare const resolveCurves: ResolveCurves
declare const makeDraftBuilder: MakeDraftBuilder

const schema: Validator<DraftInput> = passthrough()

async function execute(input: DraftInput, context: FeatureContext): Promise<SketchId> {
  // The solver lands later; with `solve: false` the coordinates are
  // taken as written.
  const { sketch } = await context
    .capability("sketch.region")
    .invoke<{ sketch: SketchId }>(resolveCurves(input, context))
  return sketch
}

/**
 * A draft that closes no region is legal while drawing but useless to an
 * extrude. Reported here as an error the user can act on, rather than as
 * a confusing failure two features downstream.
 */
async function validate(
  input: DraftInput,
  context: FeatureContext,
): Promise<readonly string[]> {
  const errors: string[] = []
  const material = input.curves.filter((curve) => !curve.construction)
  if (material.length === 0) errors.push("the draft has no material geometry")
  return errors
}

// =====================================================================
// THE COMMAND
// =====================================================================

export const draftCommand: CommandDefinition<DraftInput, SketchId> = {
  id: "draft",
  uuid: "0f5b2a1e-1c3d-4e5f-8a90-1b2c3d4e5f60",
  label: "Draft",
  icon: "pen-line",
  group: "sketch",
  shortcut: "d",
  help: "Draws two-dimensional geometry on a plane.",
  roles: DRAFT_ROLES,
  requires: DRAFT_CAPABILITIES,
  steps,
  schema,
  version: 1,
  migrations,
  execute,
  validate,
}

// =====================================================================
// THE FEATURE
// =====================================================================

export const draftFeature: FeatureApi = {
  name: "draft",
  commands: [draftCommand] as readonly CommandDefinition<never, never>[],
  // Only captures the context. No geometry and no context.cad.* here —
  // that would be a CREATION cycle, which the container rejects.
  create: (context): DraftApi => (plane) => makeDraftBuilder(context, plane),
}
