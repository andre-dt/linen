// =====================================================================
// packages/cad/common/panel.ts — THE PANEL STATE MACHINE, implemented.
//
// common/feature.ts DECLARES this machine (beginCommand, setField,
// applyTransition, stepBack, finishCommand) as types. This file is the
// implementation: pure functions over PanelState, no UI, no reactivity,
// no kernel.
//
// It stays here rather than in apps/web because the machine is part of
// the feature contract, not a rendering concern: the same walk decides
// what the panel shows AND what a replayed command means. Two
// implementations would diverge on the first change.
//
// EVERY function is total and non-throwing: an unknown transition or a
// step with no history returns the state unchanged. The panel is driven
// by user clicks, and a click that cannot apply must be a no-op, never
// an exception in the middle of a command.
// =====================================================================

import type {
  CommandDefinition, CommandStep, FieldDefinition, PanelState, PanelFieldError,
  TransitionGuard,
} from "./feature"

// =====================================================================
// 1. OPENING
// =====================================================================

/**
 * Opens a command at its first step, with every field of that step
 * seeded from its declared default. Seeding matters: a boolean field
 * that reads `undefined` until touched would make "unset" and "false"
 * indistinguishable downstream.
 */
export const beginCommand = (command: CommandDefinition<never, never>): PanelState => {
  const first = command.steps[0]
  const values = new Map<string, unknown>()
  if (first) seedDefaults(first, values)
  // Advanced on open too: a first step whose fields all carry defaults is
  // already satisfied, and showing it for one frame before it vanishes
  // would be a flicker the user cannot act on.
  return advance(settle({
    command: command.id,
    currentStep: first?.id ?? "",
    path: [],
    values,
    canBuild: false,
    errors: [],
    passes: new Map(),
  }, command), command)
}

const seedDefaults = (step: CommandStep, into: Map<string, unknown>): void => {
  for (const field of step.fields) {
    if (into.has(field.name)) continue
    const value = defaultOf(field)
    if (value !== undefined) into.set(field.name, value)
  }
}

const defaultOf = (field: FieldDefinition): unknown => {
  switch (field.kind) {
    case "boolean": return field.default
    case "choice": return field.default ?? undefined
    case "expression": return field.default ?? undefined
    case "direction": return field.default ?? undefined
    // Pickers and lists have nothing meaningful to pre-fill: an empty
    // point list is a different thing from "no points chosen yet", and
    // only the user can tell them apart.
    default: return undefined
  }
}

// =====================================================================
// 2. EDITING
// =====================================================================

export const setField = (
  state: PanelState,
  field: string,
  value: unknown,
  command: CommandDefinition<never, never>,
): PanelState => {
  // Writable if the field belongs to any step WALKED — the current one
  // or one already passed.
  //
  // Not only the current step. The values are one map for the whole
  // command, and the panel shows every field walked, so restricting
  // writes to the current step made the panel display fields it then
  // refused to change: clicking clear on the plane field did nothing,
  // silently, because choosing a plane auto-advances past the step that
  // owns it.
  //
  // A field of a step never reached is still refused. It is not part of
  // this command yet, and accepting it would let a widget write a value
  // the machine never asked for.
  const walked = [...state.path, state.currentStep]
  const owns = walked.some((id) =>
    stepOf(command, id)?.fields.some((entry) => entry.name === field),
  )
  if (!owns) return state

  const values = new Map(state.values)
  values.set(field, value)
  // Writing a value can COMPLETE the step. Advancing here rather than
  // waiting for a click is what makes picking a plane one gesture
  // instead of two.
  //
  // And emptying one can UNCOMPLETE an earlier step, which is the same
  // rule read backwards: the machine advanced because a guard fired on
  // a value, so it retreats when that value goes away. Without this,
  // "data-driven" would only be true in one direction — the panel would
  // sit on a later step showing a blank field it had already walked
  // past.
  return advance(retreat(settle({ ...state, values }, command), command), command)
}

/**
 * Walks back to the earliest step whose required fields are no longer
 * filled.
 *
 * ONLY as far as that step. A field cleared deep in a command must not
 * reset everything before it: the other values are still there, and
 * discarding the walk would throw away work the user never asked to
 * lose. Steps after the gap leave the path because they were reached
 * through it — reaching them again is what filling it in will do.
 *
 * A no-op when every walked step is still satisfied, which is the
 * ordinary case: most edits change a value without emptying it.
 */
const retreat = (
  state: PanelState,
  command: CommandDefinition<never, never>,
): PanelState => {
  const walked = [...state.path, state.currentStep]
  const broken = walked.findIndex((id) => {
    const step = stepOf(command, id)
    return step !== undefined && missingFields(step, state.values).length > 0
  })
  if (broken < 0) return state

  const target = walked[broken]
  if (target === undefined || target === state.currentStep) return state

  return settle({
    ...state,
    currentStep: target,
    path: walked.slice(0, broken),
    // The passes recorded while walking past the gap go too. A pass is
    // a completed trip through a loop, and a trip made on an answer
    // that has since been withdrawn is not one that happened.
    passes: new Map(
      [...state.passes].filter(([id]) => walked.slice(0, broken).includes(id)),
    ),
  }, command)
}

/**
 * Fires any data-driven transition whose guard now passes, repeatedly:
 * one auto-advance can complete the next step too (a step whose fields
 * all carry defaults), and stopping after one would leave the panel on a
 * step it should already have left.
 *
 * Bounded by the number of steps. A metadata cycle where every step
 * auto-advances would otherwise spin forever, and a hang in the panel is
 * a far worse failure than parking on a step.
 */
const advance = (
  state: PanelState,
  command: CommandDefinition<never, never>,
): PanelState => {
  let current = state
  for (let guard = 0; guard <= command.steps.length; guard += 1) {
    const step = stepOf(command, current.currentStep)
    if (!step) return current
    // A step with outstanding required fields is not complete, whatever
    // its guards say — the guard decides WHETHER to leave a complete
    // step, never whether the step is complete.
    if (current.errors.length > 0) return current

    const ready = step.transitions.find(
      (transition) => transition.when !== null && passes(transition.when, current.values),
    )
    if (!ready) return current

    const next = applyTransition(current, ready.id, command)
    // No movement means the transition refused (a dangling `to`);
    // looping again would spin on the same refusal.
    if (next === current || next.currentStep === current.currentStep) return next
    current = next
  }
  return current
}

/**
 * A guard is author-supplied code running on every keystroke, so a throw
 * is treated as "does not fire" rather than allowed to escape. Every
 * function in this file is total; a bad predicate must not take the panel
 * down mid-command.
 */
const passes = (
  guard: TransitionGuard,
  values: ReadonlyMap<string, unknown>,
): boolean => {
  try {
    if (guard.kind === "predicate") return guard.test(values)
    // A schema tests the values as a plain object, which is the shape a
    // feature author writes a schema against — not a Map.
    return guard.schema.safeParse(Object.fromEntries(values)).success
  } catch {
    return false
  }
}

// =====================================================================
// 3. NAVIGATION
// =====================================================================

/**
 * Applies a transition by id. Blocked while the current step still has
 * unfilled required fields — the machine is what guarantees ordering, so
 * it cannot let the user walk past a gap and discover it at build time.
 *
 * A transition whose `to` is empty is TERMINAL: the state parks on the
 * final step with canBuild true, and the caller commits.
 */
export const applyTransition = (
  state: PanelState,
  transition: string,
  command: CommandDefinition<never, never>,
): PanelState => {
  const step = stepOf(command, state.currentStep)
  const chosen = step?.transitions.find((entry) => entry.id === transition)
  if (!step || !chosen) return state

  const missing = missingFields(step, state.values)
  if (missing.length > 0) return { ...state, errors: missing, canBuild: false }

  // A transition that names a variant records the user's choice as a
  // value, which is how the persisted input learns its `kind` without
  // the UI knowing what the union looks like.
  let values = new Map(state.values)
  if (chosen.variant !== null) values.set("kind", chosen.variant)

  if (chosen.to === "") {
    // Terminal. If we are ending from inside a loop, that final pass
    // still has to be closed, or the last curve drawn would be dropped.
    const closed = closeLoop(state, step.id, values, command)
    return settle({
      ...state,
      values: closed.values,
      passes: closed.passes,
      path: [...state.path, step.id],
    }, command)
  }

  const next = stepOf(command, chosen.to)
  // A dangling `to` is a metadata bug that validateFeature catches in
  // CI. At runtime we refuse to move rather than blank the panel.
  if (!next) return state

  // Returning to a step already walked is a LOOP CLOSING: everything
  // gathered since leaving it is one completed pass.
  const closed = closeLoop(state, next.id, values, command)
  values = new Map(closed.values)

  seedDefaults(next, values)
  return settle({
    ...state,
    currentStep: next.id,
    path: [...state.path, step.id],
    values,
    passes: closed.passes,
  }, command)
}

/**
 * Closes a pass through `hub` if we are in fact returning to it: harvests
 * the fields belonging to the steps walked since, files them under the
 * hub, and clears them from `values` so the next pass starts empty.
 *
 * A no-op when `hub` is not on the path — the ordinary linear case, where
 * every step is visited once and nothing is ever harvested.
 */
const closeLoop = (
  state: PanelState,
  hub: string,
  values: ReadonlyMap<string, unknown>,
  command: CommandDefinition<never, never>,
): {
  readonly values: Map<string, unknown>
  readonly passes: ReadonlyMap<string, readonly ReadonlyMap<string, unknown>[]>
} => {
  const next = new Map(values)
  const entered = state.path.lastIndexOf(hub)
  if (entered < 0) return { values: next, passes: state.passes }

  // The steps walked since leaving the hub, plus the one we are on: the
  // body of this pass. The hub's OWN fields are excluded — a draft's
  // `construction` flag belongs to the draft, not to each curve.
  const inLoop = [...state.path.slice(entered + 1), state.currentStep]
    .filter((id) => id !== hub)
  if (inLoop.length === 0) return { values: next, passes: state.passes }
  const harvested = new Map<string, unknown>()
  for (const id of inLoop) {
    for (const field of stepOf(command, id)?.fields ?? []) {
      if (!next.has(field.name)) continue
      harvested.set(field.name, next.get(field.name))
      next.delete(field.name)
    }
  }
  // The variant that chose this pass belongs to the pass, not to the
  // command: it is what says "this one was a circle".
  if (next.has("kind")) {
    harvested.set("kind", next.get("kind"))
    next.delete("kind")
  }
  if (harvested.size === 0) return { values: next, passes: state.passes }

  const passes = new Map(state.passes)
  passes.set(hub, [...(passes.get(hub) ?? []), harvested])
  return { values: next, passes }
}

/**
 * Undo one STEP — not one field. Returning to a step keeps everything
 * already entered, so stepping back to change the plane does not discard
 * the curves drawn after it.
 */
export const stepBack = (
  state: PanelState,
  command: CommandDefinition<never, never>,
): PanelState => {
  const previous = state.path[state.path.length - 1]
  if (previous === undefined) return state
  if (!stepOf(command, previous)) return state
  return settle({
    ...state,
    currentStep: previous,
    path: state.path.slice(0, -1),
  }, command)
}

/** Jumps back to any step already walked. Clicking a breadcrumb. */
export const stepTo = (
  state: PanelState,
  stepId: string,
  command: CommandDefinition<never, never>,
): PanelState => {
  const index = state.path.indexOf(stepId)
  if (index < 0) return state
  return settle({
    ...state,
    currentStep: stepId,
    path: state.path.slice(0, index),
  }, command)
}

// =====================================================================
// 4. BUILDING
// =====================================================================

/**
 * Produces the serializable input. Only meaningful when `canBuild`;
 * callers are expected to check, and a caller that does not gets an
 * object with whatever was filled rather than a throw.
 */
export const finishCommand = <Input>(state: PanelState): Input => {
  const input: Record<string, unknown> = Object.fromEntries(state.values)
  // Each hub contributes its completed passes as a list, under the hub's
  // own id — "tools" for a draft, so the input carries every curve drawn
  // rather than only the last one.
  for (const [hub, passes] of state.passes) {
    input[hub] = passes.map((pass) => Object.fromEntries(pass))
  }
  return input as Input
}

// =====================================================================
// 5. INTERNALS
// =====================================================================

const stepOf = (
  command: CommandDefinition<never, never>,
  id: string,
): CommandStep | undefined => command.steps.find((step) => step.id === id)

/**
 * A required field is missing when it holds nothing at all, or holds a
 * list shorter than its declared minimum. Reported per field so the
 * panel can mark the offending widget rather than showing one opaque
 * "incomplete" message.
 */
const missingFields = (
  step: CommandStep,
  values: ReadonlyMap<string, unknown>,
): readonly PanelFieldError[] => {
  const errors: PanelFieldError[] = []
  for (const field of step.fields) {
    if (field.optional) continue
    const value = values.get(field.name)
    if (value === undefined || value === null || value === "") {
      errors.push({ field: field.name, message: `${field.label} is required` })
      continue
    }
    const minimum = minimumItemsOf(field)
    if (minimum !== null && Array.isArray(value) && value.length < minimum) {
      errors.push({
        field: field.name,
        message: `${field.label} needs at least ${minimum} ${minimum === 1 ? "item" : "items"}`,
      })
    }
  }
  return errors
}

const minimumItemsOf = (field: FieldDefinition): number | null => {
  switch (field.kind) {
    case "point-list": return field.minimumItems
    case "reference": return field.minimumItems
    case "table": return field.minimumRows
    default: return null
  }
}

/**
 * Recomputes the derived half of the state — errors and canBuild — after
 * any change. Keeping it in one place is why no caller can leave the two
 * disagreeing.
 *
 * `canBuild` means: this step is complete AND it offers a way to end.
 * A step whose only exits lead elsewhere is mid-command by definition.
 */
const settle = (
  state: PanelState,
  command: CommandDefinition<never, never>,
): PanelState => {
  const step = stepOf(command, state.currentStep)
  if (!step) return { ...state, errors: [], canBuild: false }

  // Every step WALKED is checked, not only the current one.
  //
  // A required field can be emptied after the machine has moved past
  // the step that owns it — clearing the plane of a draft is exactly
  // that. Checking only the current step left the command silently
  // incomplete: the value was gone, the panel redrew the empty field,
  // and nothing said so. `canBuild` even stayed true, offering to
  // finish a draft with no plane.
  //
  // Deduplicated by field name for the same reason the panel
  // deduplicates its fields: a hub is on the path once per visit, and
  // its missing field is one error however many times it was passed.
  const seen = new Set<string>()
  const errors: PanelFieldError[] = []
  for (const id of [...state.path, state.currentStep]) {
    const walked = stepOf(command, id)
    if (!walked) continue
    for (const error of missingFields(walked, state.values)) {
      if (seen.has(error.field)) continue
      seen.add(error.field)
      errors.push(error)
    }
  }

  const terminal =
    step.transitions.length === 0 ||
    step.transitions.some((transition) => transition.to === "")

  // A HUB — a step its own transitions can return to — is not buildable
  // until at least one pass has closed. Otherwise "Finish" is offered on
  // an empty draft, which the feature's own validate would then reject:
  // better to not offer it than to reject the click.
  const isHub = step.transitions.some((transition) =>
    stepOf(command, transition.to)?.transitions.some((back) => back.to === step.id),
  )
  const filled = !isHub || (state.passes.get(step.id)?.length ?? 0) > 0

  return { ...state, errors, canBuild: errors.length === 0 && terminal && filled }
}
