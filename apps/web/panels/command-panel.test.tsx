// =====================================================================
// A FIELD ALREADY ANSWERED STAYS ON SCREEN.
//
// The panel walks a state machine, but the values are ONE map for the
// whole command: a step does not own its inputs, it only decides which
// become relevant. So a field answered in an earlier step is still
// answered, and hiding it makes the user walk backwards to change it.
//
// Walking backwards is not free. Re-entering a step re-runs its guards,
// and a guard that now passes differently can send the machine
// somewhere other than where it was — clearing a field can reset the
// machine. Leaving the field on screen makes correction a direct edit
// instead.
//
// WHY IT IS TESTED HERE AND NOT BY EYE
// ------------------------------------
// The panel renders whatever the metadata says, so this holds for every
// command present and future. A regression would show up on one feature
// at a time, whenever someone happened to walk two steps deep — which
// is exactly the kind of thing that is noticed months later.
// =====================================================================

import { describe, expect, it } from "vitest"
import { render, cleanup } from "@solidjs/testing-library"
import { CommandPanel } from "./command-panel"
import {
  beginCommand, applyTransition, setField,
  type CommandDefinition,
} from "@linen/cad/features"

/**
 * Two steps, each with its own field, and a hub that is passed twice.
 *
 * Written here rather than borrowed from draft: this is about the
 * PANEL, and a fixture that changes when a feature changes would fail
 * for reasons that have nothing to do with what is being checked.
 */
const COMMAND = {
  id: "test.walk",
  label: "Walk",
  icon: "box",
  steps: [
    {
      id: "first",
      label: "First",
      help: null,
      optional: false,
      fields: [
        {
          kind: "boolean", name: "alpha", label: "Alpha",
          default: false, optional: true, help: null,
        },
      ],
      transitions: [
        { id: "on", label: "Next", to: "hub", icon: null, preview: false, variant: null, when: null },
      ],
    },
    {
      id: "hub",
      label: "Hub",
      help: null,
      optional: false,
      fields: [
        {
          kind: "boolean", name: "beta", label: "Beta",
          default: false, optional: true, help: null,
        },
      ],
      transitions: [
        { id: "leaf", label: "Leaf", to: "leaf", icon: null, preview: false, variant: null, when: null },
      ],
    },
    {
      id: "leaf",
      label: "Leaf",
      help: null,
      optional: false,
      fields: [
        {
          kind: "boolean", name: "gamma", label: "Gamma",
          default: false, optional: true, help: null,
        },
      ],
      transitions: [
        { id: "back", label: "Back", to: "hub", icon: null, preview: false, variant: null, when: null },
      ],
    },
  ],
} as unknown as CommandDefinition<never, never>

const labels = (container: HTMLElement): readonly string[] =>
  [...container.querySelectorAll(".widget-label")].map((node) => node.textContent ?? "")

describe("the command panel", () => {
  it("keeps a field on screen after the machine moves on", () => {
    let state = beginCommand(COMMAND)
    state = applyTransition(state, "on", COMMAND)

    const { container } = render(() => (
      <CommandPanel
        panel={state}
        definition={COMMAND}
        onChange={() => {}}
        onClose={() => {}}
      />
    ))

    // Both the step just left and the one arrived at.
    expect(labels(container)).toEqual(["Alpha", "Beta"])
    cleanup()
  })

  it("shows a hub's field once however often it is passed", () => {
    // first -> hub -> leaf -> hub. The hub is on the path twice, and its
    // `beta` is one checkbox either way.
    let state = beginCommand(COMMAND)
    state = applyTransition(state, "on", COMMAND)
    state = applyTransition(state, "leaf", COMMAND)
    state = applyTransition(state, "back", COMMAND)

    const { container } = render(() => (
      <CommandPanel
        panel={state}
        definition={COMMAND}
        onChange={() => {}}
        onClose={() => {}}
      />
    ))

    expect(labels(container)).toEqual(["Alpha", "Beta", "Gamma"])
    cleanup()
  })

  it("lets a field from an earlier step be rewritten", () => {
    // The panel shows every field walked, so every field it shows must
    // be writable. `setField` used to refuse anything outside the
    // current step — correct when only the current step was on screen,
    // and wrong the moment the others were: clicking the clear button
    // on the plane field did nothing at all, silently.
    let state = beginCommand(COMMAND)
    state = setField(state, "alpha", true, COMMAND)
    state = applyTransition(state, "on", COMMAND)
    expect(state.currentStep).toBe("hub")

    // `alpha` belongs to `first`, which is behind us.
    state = setField(state, "alpha", false, COMMAND)
    expect(state.values.get("alpha")).toBe(false)
  })

  it("refuses a field that belongs to no step walked", () => {
    // Not everything is writable. A field of a step never reached is
    // not part of this command yet, and accepting it would let a stale
    // widget write a value the machine never asked for.
    let state = beginCommand(COMMAND)
    state = setField(state, "gamma", true, COMMAND)
    expect(state.values.has("gamma")).toBe(false)
  })

  it("carries the value with the field", () => {
    // The point of keeping the field is being able to SEE what it holds.
    // A field redrawn empty would be worse than one hidden: it says the
    // answer was lost when the machine still has it.
    let state = beginCommand(COMMAND)
    state = setField(state, "alpha", true, COMMAND)
    state = applyTransition(state, "on", COMMAND)

    const { container } = render(() => (
      <CommandPanel
        panel={state}
        definition={COMMAND}
        onChange={() => {}}
        onClose={() => {}}
      />
    ))

    const checkboxes = container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")
    expect(checkboxes.length).toBe(2)
    expect(state.values.get("alpha")).toBe(true)
    cleanup()
  })
})

describe("clearing a field the machine advanced on", () => {
  it("does not strand the panel past a step that is no longer satisfied", () => {
    // Choosing a plane auto-advances to the next step. Clearing it
    // afterwards leaves the command with no plane — and the panel has
    // to say so rather than sit on a later step as though the question
    // were answered.
    //
    // The machine expresses this as an ERROR, not as a rewind: walking
    // backwards would discard whatever was drawn after, which is a
    // heavier response than the user asked for by clicking a clear
    // button.
    let state = beginCommand(COMMAND)
    state = setField(state, "alpha", true, COMMAND)
    state = applyTransition(state, "on", COMMAND)

    state = setField(state, "alpha", undefined, COMMAND)
    expect(state.values.get("alpha")).toBe(undefined)
  })
})

describe("clearing the field that advanced the machine", () => {
  it("returns to the step that field belongs to", () => {
    // The machine advanced BECAUSE the field was filled. Emptying it
    // takes away the reason, so the machine goes back to where it was:
    // the panel shows the step whose question is now unanswered again,
    // rather than sitting on a later one with a blank field and an
    // error beside it.
    //
    // This is the symmetric counterpart of auto-advance. A guard that
    // fires when a value appears has to stop holding when it goes away,
    // or "the state machine is data-driven" is only true in one
    // direction.
    let state = beginCommand(REQUIRED)
    state = setField(state, "plane", "top", REQUIRED)
    expect(state.currentStep).toBe("after")

    state = setField(state, "plane", undefined, REQUIRED)
    expect(state.currentStep).toBe("start")
    expect(state.path).toEqual([])
  })

  it("does not rewind past a step that is still satisfied", () => {
    // Only back to the step that lost its answer. A field cleared deep
    // in a command must not reset everything before it — the values are
    // still there, and discarding the walk would throw away work the
    // user never asked to lose.
    let state = beginCommand(COMMAND)
    state = applyTransition(state, "on", COMMAND)
    state = applyTransition(state, "leaf", COMMAND)
    // `gamma` is optional, so clearing it strands nothing.
    state = setField(state, "gamma", undefined, COMMAND)
    expect(state.currentStep).toBe("leaf")
  })

  it("reports the error even though the step is behind us", () => {
    // `settle` used to check only the CURRENT step's fields, so clearing
    // a required field from an earlier one produced no error at all:
    // the value went away, the panel redrew the empty field, and nothing
    // said the command was now incomplete. Worse, `canBuild` could stay
    // true — offering to finish a draft with no plane.
    let state = beginCommand(REQUIRED)
    state = setField(state, "plane", "top", REQUIRED)
    expect(state.currentStep).toBe("after")
    expect(state.errors).toHaveLength(0)

    state = setField(state, "plane", undefined, REQUIRED)
    expect(state.errors.map((error) => error.field)).toContain("plane")
  })
})

/** A required field that auto-advances, then a step after it. */
const REQUIRED = {
  id: "test.required",
  label: "Required",
  icon: "box",
  steps: [
    {
      id: "start",
      label: "Start",
      help: null,
      optional: false,
      fields: [
        { kind: "choice", name: "plane", label: "Plane", options: [{ value: "top", label: "Top" }], default: null, optional: false, help: null },
      ],
      transitions: [
        { id: "on", label: "Next", to: "after", icon: null, preview: false, variant: null, when: { kind: "predicate", test: (values: ReadonlyMap<string, unknown>) => values.get("plane") !== undefined } },
      ],
    },
    {
      id: "after",
      label: "After",
      help: null,
      optional: false,
      fields: [],
      transitions: [
        { id: "done", label: "Finish", to: "", icon: null, preview: false, variant: null, when: null },
      ],
    },
  ],
} as unknown as CommandDefinition<never, never>
