// =====================================================================
// src/extrude/feature.ts
//
// IMPLEMENTATION + METADATA: the bridge between api.ts (what you
// write), kernel.ts (what the kernel does) and the HUD (what you see).
//
// The command array is the SINGLE SOURCE. The panel is derived from it,
// never written alongside it — two declarations would diverge on the
// first change.
// =====================================================================

import type { BodyId, Validator } from "../common/kernel"
import type { Reference, SketchId } from "../common/api"
import type {
  CommandDefinition, CommandStep, FeatureApi, FeatureContext, Migrations,
} from "../common/feature"
import { EXTRUDE_CAPABILITIES, EXTRUDE_ROLES } from "./kernel"
import type { ExtrudeInput, ExtrudeExtent, ExtrudeStepExtent, ExtrudeApi } from "./api"

// =====================================================================
// STEPS — the state machine, as data
// =====================================================================
// Mirrors the interfaces in api.ts. `validateFeature` checks in CI that
// the two have not diverged.

const steps: readonly CommandStep[] = [
  {
    id: "profile",
    label: "Profile",
    help: null,
    optional: false,
    autoAdvance: true,
    fields: [
      {
        kind: "reference", name: "profile", label: "Profile", of: "draft",
        cardinality: "one", minimumItems: null,
        optional: false, help: null,
      },
    ],
    transitions: [
      { id: "next", label: "Extent", to: "extent", icon: null, preview: false, variant: null },
    ],
  },
  {
    id: "extent",
    label: "Extent",
    help: null,
    optional: false,
    autoAdvance: false,
    fields: [],
    // Each transition is one variant of the `ExtrudeExtent` union, and
    // `variant` ties the user's choice to the persisted `kind`. This is
    // what replaces the four conditional optionals.
    transitions: [
      { id: "distance", label: "Distance", to: "extent.distance", icon: "arrow-up", preview: true, variant: "distance" },
      { id: "symmetric", label: "Symmetric", to: "extent.symmetric", icon: "arrows-vertical", preview: true, variant: "symmetric" },
      { id: "two-sided", label: "Two sided", to: "extent.two-sided", icon: "arrows-split", preview: true, variant: "two-sided" },
      { id: "up-to-face", label: "Up to face", to: "extent.up-to-face", icon: "target", preview: true, variant: "up-to-face" },
      { id: "through", label: "Through all", to: "combine", icon: "arrow-through", preview: true, variant: "through" },
    ],
  },
  {
    id: "extent.distance",
    label: "Distance",
    help: null,
    optional: false,
    autoAdvance: false,
    fields: [
      {
        kind: "expression", name: "value", label: "Distance", dimension: "length",
        default: null, minimum: 0, maximum: null, increment: 1,
        draggable: "normal", // dragging the viewport arrow edits this
        optional: false, help: null,
      },
      {
        kind: "expression", name: "taper", label: "Taper angle", dimension: "angle",
        default: null, minimum: -1.5707963, maximum: 1.5707963, increment: 0.01,
        draggable: null,
        optional: true, // absence is meaningful here: no taper
        help: "Slants the side faces.",
      },
    ],
    transitions: [
      { id: "next", label: "Combine", to: "combine", icon: null, preview: false, variant: null },
    ],
  },
  {
    id: "extent.symmetric",
    label: "Symmetric",
    help: "Half the length on each side of the plane.",
    optional: false,
    autoAdvance: false,
    fields: [
      {
        kind: "expression", name: "total", label: "Total length", dimension: "length",
        default: null, minimum: 0, maximum: null, increment: 1, draggable: "normal",
        optional: false, help: null,
      },
      {
        kind: "expression", name: "taper", label: "Taper angle", dimension: "angle",
        default: null, minimum: -1.5707963, maximum: 1.5707963, increment: 0.01, draggable: null,
        optional: true, help: null,
      },
    ],
    transitions: [
      { id: "next", label: "Combine", to: "combine", icon: null, preview: false, variant: null },
    ],
  },
  {
    id: "extent.two-sided",
    label: "Two sided",
    help: null,
    optional: false,
    autoAdvance: false,
    fields: [
      {
        kind: "expression", name: "forward", label: "Forward", dimension: "length",
        default: null, minimum: 0, maximum: null, increment: 1, draggable: "normal",
        optional: false, help: null,
      },
      {
        kind: "expression", name: "backward", label: "Backward", dimension: "length",
        default: null, minimum: 0, maximum: null, increment: 1, draggable: "normal",
        optional: false, help: null,
      },
    ],
    transitions: [
      { id: "next", label: "Combine", to: "combine", icon: null, preview: false, variant: null },
    ],
  },
  {
    id: "extent.up-to-face",
    label: "Up to face",
    help: null,
    optional: false,
    autoAdvance: false,
    fields: [
      {
        kind: "selector", name: "face", label: "Target face",
        accepts: ["face"], cardinality: "one",
        filter: null, autoFocus: true,
        optional: false, help: null,
      },
      {
        kind: "expression", name: "offset", label: "Offset", dimension: "length",
        default: null, minimum: null, maximum: null, increment: 0.5, draggable: "normal",
        optional: true, help: null,
      },
      // NO `taper` field here. It is not hidden by a condition — it does
      // not exist in this step, exactly as in ExtrudeStepUpToFace.
    ],
    transitions: [
      { id: "next", label: "Combine", to: "combine", icon: null, preview: false, variant: null },
    ],
  },
  {
    id: "combine",
    label: "Combine",
    help: null,
    optional: false,
    autoAdvance: true,
    fields: [
      {
        kind: "selector", name: "target", label: "Target body",
        accepts: ["body"], cardinality: "one", filter: null, autoFocus: false,
        optional: true, help: null,
      },
    ],
    transitions: [
      { id: "new", label: "New body", to: "", icon: "cube-plus", preview: true, variant: "new" },
      { id: "add", label: "Add", to: "", icon: "union", preview: true, variant: "add" },
      { id: "subtract", label: "Subtract", to: "", icon: "difference", preview: true, variant: "subtract" },
      { id: "intersect", label: "Intersect", to: "", icon: "intersect", preview: true, variant: "intersect" },
    ],
  },
]

// =====================================================================
// MIGRATIONS
// =====================================================================
// Older models regenerate with the older semantics instead of breaking.

const migrations: Migrations<ExtrudeInput> = new Map([
  // Version 0 had no `combine`: it always produced a new body.
  [0, (stored: unknown) => ({
    ...(stored as ExtrudeInput),
    combine: { kind: "new" as const },
  })],
])

// =====================================================================
// EXECUTION
// =====================================================================

type ResolveExtent = (extent: ExtrudeExtent, context: FeatureContext) => object
type ApplyCombine = (
  body: BodyId,
  operation: ExtrudeInput["combine"],
  context: FeatureContext,
) => Promise<BodyId>
type MakeExtrudeBuilder = (
  context: FeatureContext,
  profile: Reference<SketchId>,
) => ExtrudeStepExtent

declare const resolveExtent: ResolveExtent
declare const applyCombine: ApplyCombine
declare const makeExtrudeBuilder: MakeExtrudeBuilder
declare const schema: Validator<ExtrudeInput>

async function execute(input: ExtrudeInput, context: FeatureContext): Promise<BodyId> {
  const { body } = await context.capability("solid.extrude").invoke<{ body: BodyId }>({
    profile: input.profile,
    direction: input.direction,
    ...resolveExtent(input.extent, context), // expressions become numbers
  })
  return applyCombine(body, input.combine, context)
}

/**
 * Does every referenced entity belong to the target? Checked BEFORE the
 * native call: CadQuery carries a live `TODO: we segfault` for skipping
 * exactly this, and across our N-API boundary it would take down the
 * whole process rather than raise.
 */
async function validate(
  input: ExtrudeInput,
  context: FeatureContext,
): Promise<readonly string[]> {
  const errors: string[] = []
  if (input.extent.kind === "up-to-face" && input.combine.kind !== "new") {
    const belongs = await context.entityBelongsTo(input.extent.face, input.combine.target)
    if (!belongs) errors.push("the target face does not belong to the body being modified")
  }
  return errors
}

// =====================================================================
// THE COMMAND
// =====================================================================

export const extrudeCommand: CommandDefinition<ExtrudeInput, BodyId> = {
  id: "extrude",
  label: "Extrude",
  icon: "extrude",
  group: "create",
  shortcut: "e",
  help: "Creates a solid by sweeping a profile along a direction.",
  roles: EXTRUDE_ROLES,
  requires: EXTRUDE_CAPABILITIES,
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

export const extrudeFeature: FeatureApi = {
  name: "extrude",
  commands: [extrudeCommand] as readonly CommandDefinition<never, never>[],
  // Only captures the context. No geometry and no context.cad.* here —
  // that would be a CREATION cycle, which the container rejects.
  create: (context): ExtrudeApi => (profile) => makeExtrudeBuilder(context, profile),
}
