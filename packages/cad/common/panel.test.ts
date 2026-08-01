// =====================================================================
// packages/cad/common/panel.test.ts
//
// The panel state machine, with the emphasis on DATA-DRIVEN transitions:
// a step that has what it wanted should end without asking the user to
// confirm it. The rules worth pinning are the ones a reader would
// otherwise have to infer — when a guard fires, when it must not, and
// what stops a guard from taking the panel down.
// =====================================================================

import { z } from "zod"
import { describe, expect, it } from "vitest"

import { beginCommand, setField, applyTransition } from "./panel"
import type { CommandDefinition, CommandStep } from "./feature"

// A tiny two-step command: pick a thing, then name it. Enough shape to
// exercise guards without dragging a real feature's metadata in.
const step = (over: Partial<CommandStep> & { id: string }): CommandStep => ({
  label: over.id,
  help: null,
  fields: [],
  transitions: [],
  optional: false,
  ...over,
})

const command = (steps: readonly CommandStep[]): CommandDefinition<never, never> =>
  ({ id: "test", steps } as unknown as CommandDefinition<never, never>)

const textField = (name: string, optional = false) =>
  ({ kind: "expression", name, label: name, dimension: "length",
     default: null, minimum: null, maximum: null, increment: null,
     draggable: null, optional, help: null }) as never

describe("data-driven transitions", () => {
  it("fires a predicate guard as soon as the value arrives", () => {
    const definition = command([
      step({
        id: "first",
        fields: [textField("thing")],
        transitions: [{
          id: "next", label: "Next", to: "second",
          icon: null, preview: false, variant: null,
          when: { kind: "predicate", test: (values) => values.get("thing") !== undefined },
        }],
      }),
      step({ id: "second" }),
    ])

    const opened = beginCommand(definition)
    expect(opened.currentStep).toBe("first")

    // No click: writing the field is the whole gesture.
    const after = setField(opened, "thing", "12", definition)
    expect(after.currentStep).toBe("second")
    expect(after.path).toEqual(["first"])
  })

  it("fires a schema guard when the values take the declared shape", () => {
    const schema = z.object({
      plane: z.object({ kind: z.literal("datum"), plane: z.string().min(1) }),
    })
    const definition = command([
      step({
        id: "plane",
        fields: [textField("plane")],
        transitions: [{
          id: "next", label: "Draw", to: "tools",
          icon: null, preview: false, variant: null,
          when: { kind: "schema", schema },
        }],
      }),
      step({ id: "tools" }),
    ])

    let state = beginCommand(definition)
    // A value that does NOT parse leaves the step alone, even though the
    // field is now filled — shape is the test, not mere presence.
    state = setField(state, "plane", { kind: "face" }, definition)
    expect(state.currentStep).toBe("plane")

    state = setField(state, "plane", { kind: "datum", plane: "front" }, definition)
    expect(state.currentStep).toBe("tools")
  })

  it("never fires while a required field of the step is still missing", () => {
    const definition = command([
      step({
        id: "first",
        fields: [textField("a"), textField("b")],
        // A guard that would always pass. The step is still incomplete,
        // and completeness is the machine's call, not the guard's.
        transitions: [{
          id: "next", label: "Next", to: "second",
          icon: null, preview: false, variant: null,
          when: { kind: "predicate", test: () => true },
        }],
      }),
      step({ id: "second" }),
    ])

    const state = setField(beginCommand(definition), "a", "1", definition)
    expect(state.currentStep).toBe("first")

    const done = setField(state, "b", "2", definition)
    expect(done.currentStep).toBe("second")
  })

  it("leaves a transition with no guard to the user", () => {
    const definition = command([
      step({
        id: "first",
        fields: [textField("thing")],
        transitions: [{
          id: "next", label: "Next", to: "second",
          icon: null, preview: false, variant: null, when: null,
        }],
      }),
      step({ id: "second" }),
    ])

    // Filled and complete, but a null guard means this is a CHOICE.
    const state = setField(beginCommand(definition), "thing", "12", definition)
    expect(state.currentStep).toBe("first")
    expect(applyTransition(state, "next", definition).currentStep).toBe("second")
  })

  it("advances across several steps when each one is already satisfied", () => {
    const always = { kind: "predicate" as const, test: () => true }
    const definition = command([
      step({
        id: "a",
        transitions: [{ id: "x", label: "x", to: "b", icon: null, preview: false, variant: null, when: always }],
      }),
      step({
        id: "b",
        transitions: [{ id: "x", label: "x", to: "c", icon: null, preview: false, variant: null, when: always }],
      }),
      step({ id: "c" }),
    ])

    // Every step is complete on arrival, so opening the command walks
    // straight through to the one that actually wants something.
    expect(beginCommand(definition).currentStep).toBe("c")
  })

  it("does not spin forever on metadata that cycles", () => {
    const always = { kind: "predicate" as const, test: () => true }
    const definition = command([
      step({
        id: "a",
        transitions: [{ id: "x", label: "x", to: "b", icon: null, preview: false, variant: null, when: always }],
      }),
      step({
        id: "b",
        transitions: [{ id: "x", label: "x", to: "a", icon: null, preview: false, variant: null, when: always }],
      }),
    ])

    // A hang in the panel is far worse than parking on a step, so the
    // walk is bounded. Reaching this assertion at all is the test.
    const state = beginCommand(definition)
    expect(["a", "b"]).toContain(state.currentStep)
  })

  it("treats a throwing guard as 'does not fire' rather than crashing", () => {
    const definition = command([
      step({
        id: "first",
        fields: [textField("thing")],
        transitions: [{
          id: "next", label: "Next", to: "second",
          icon: null, preview: false, variant: null,
          when: {
            kind: "predicate",
            test: () => { throw new Error("author bug") },
          },
        }],
      }),
      step({ id: "second" }),
    ])

    // Author-supplied code runs on every keystroke; a bad predicate must
    // not take the command down mid-edit.
    const state = setField(beginCommand(definition), "thing", "12", definition)
    expect(state.currentStep).toBe("first")
  })
})
