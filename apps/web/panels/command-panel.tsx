// =====================================================================
// apps/web/panels/command-panel.tsx — THE GENERIC PANEL.
//
// The payoff of describing features as data. This component renders the
// panel for EVERY feature — present and future, built-in and
// user-defined — by walking `steps` and switching on `field.kind`.
//
// If you ever need `if (command.id === "extrude")` in this file, the
// metadata is missing something. Fix it there, not here.
//
// WHY A STATE MACHINE RATHER THAN A FLAT FORM
// -------------------------------------------
// Onshape derives its panel from a flat parameter list plus visibility
// predicates, so `draftAngle` always exists and is merely hidden. Here
// the field does not exist until the step that makes it relevant, which
// removes conditional visibility logic from the UI entirely — and means
// undo works per step rather than per field.
//
// The panel is a PURE VIEW of a PanelState: every interaction calls out
// through `onChange`, and the new state comes back as a prop. The
// machine itself lives in @linen/cad (common/panel.ts), because the same
// walk has to mean the same thing when a command is replayed from git.
//
// PLACEMENT
// ---------
// The panel FLOATS: dragged by its header, clamped to the viewport, and
// remembered in localStorage — the same behaviour as the view cube, from
// the same `createFloating` hook. A designer panel sits over the model
// the user is trying to see, so where it sits is their call, and it would
// be tiresome to make that call again on every reload.
// =====================================================================

import {
  For, Show, Switch, Match, createMemo,
} from "solid-js"
import { createFloating } from "../widgets/floating"
import { LucideIcon } from "../widgets/lucide-icon"
import {
  setField, applyTransition,
  type CommandDefinition, type CommandStep, type FieldDefinition,
  type StepTransition, type PanelState,
} from "@linen/cad/features"
import { NumberWithUnit } from "../widgets/number-with-unit"
import { Checkbox } from "../widgets/checkbox"
import { ButtonGroup } from "../widgets/button-group"
import { Dropdown } from "../widgets/dropdown"
import { ViewportPicker } from "../widgets/viewport-picker"
import { DirectionPicker } from "../widgets/direction-picker"
import { PlanePicker } from "../widgets/plane-picker"
import { FeatureList } from "../widgets/feature-list"
import { PointList } from "../widgets/point-list"
import { Grid } from "../widgets/grid"

interface CommandPanelProps {
  readonly panel: PanelState
  readonly definition: CommandDefinition<never, never>
  /** The new state after any interaction. The parent stores it. */
  readonly onChange: (panel: PanelState) => void
  readonly onClose: () => void
}

/** Width of the panel. Mirrors --hud-panel-width in the stylesheet: the
 *  drag clamp needs the footprint in numbers, and out of step the panel
 *  would be allowed to hang off an edge. */
const PANEL_WIDTH = 260
/** Clamping height. The panel's real height varies with the step's field
 *  count, so this is the amount kept on screen rather than a measurement
 *  — enough that the header and the first field always stay reachable. */
const PANEL_MIN_VISIBLE = 180

export function CommandPanel(props: CommandPanelProps) {
  const step = createMemo<CommandStep | undefined>(() =>
    props.definition.steps.find((entry) => entry.id === props.panel.currentStep),
  )

  /**
   * The fields of every step walked, in the order they were reached.
   *
   * A field does not disappear when the machine moves on. The values are
   * ONE map for the whole command — a step does not own its inputs, it
   * only decides which become relevant — so a field already answered is
   * still answered, and hiding it makes the user walk backwards to
   * change it. Walking backwards is not free either: re-entering a step
   * re-runs its guards, which can send the machine somewhere other than
   * where it was.
   *
   * Deduplicated by NAME. A hub contributes its fields on every visit —
   * draft's `tools` is in the path once per shape drawn — and its
   * `construction` checkbox is one checkbox however many times it was
   * passed through.
   */
  const walkedFields = createMemo<readonly FieldDefinition[]>(() => {
    const seen = new Set<string>()
    const fields: FieldDefinition[] = []
    for (const id of [...props.panel.path, props.panel.currentStep]) {
      const walked = props.definition.steps.find((entry) => entry.id === id)
      if (!walked) continue
      for (const field of walked.fields) {
        if (seen.has(field.name)) continue
        seen.add(field.name)
        fields.push(field)
      }
    }
    return fields
  })

  // Dragged by the header, remembered across reloads. One key for every
  // command: the user positions "the designer", not a panel per feature,
  // and having extrude open somewhere else than draft would read as the
  // panel jumping around on its own.
  const floating = createFloating({
    storageKey: "linen.command-panel.position",
    initial: () => ({ x: Math.max(0, window.innerWidth - PANEL_WIDTH - 20), y: 104 }),
    size: () => ({ width: PANEL_WIDTH, height: PANEL_MIN_VISIBLE }),
  })

  // Has the user tried to LEAVE the current step? Until they have, an
  // unfilled field is simply unreached, and marking it red says nothing
  // they do not already know.
  //
  // Reset per step rather than per command: arriving at a fresh step
  // starts the same way, and carrying the flag forward would greet each
 
  return (
    <Show when={step()}>
      {(current) => (
        <div
          // SECONDARY material: the designer floats over the side columns
          // and is where the user is actually working, so it should read
          // as distinct from the panels it covers rather than merging
          // into them. See .hud-panel-secondary.
          class="hud-panel hud-panel-secondary command-panel"
          style={{ left: `${floating.position().x}px`, top: `${floating.position().y}px` }}
        >
          <header
            class="hud-list-head command-panel-header"
            classList={{ dragging: floating.dragging() }}
            {...floating.handleProps}
          >
            <h2>{props.definition.label}</h2>
            <div class="hud-head-actions">
              <button class="hud-icon-button" onClick={props.onClose} aria-label="Close">
                <LucideIcon name="x" size={14} />
              </button>
            </div>
          </header>

          {/* EVERY field walked so far, not just the current step's.
              
              A field that vanishes when the machine moves on is a field
              the user cannot correct without going back — and going
              back is not free: the values are one map for the whole
              command, so re-entering a step re-runs its guards and can
              move the machine somewhere else. Leaving the fields on
              screen makes correction a direct edit, which is what the
              persistent value map was always for.
              
              Deduplicated by name, because a hub visited more than once
              contributes its fields more than once — `tools` appears in
              the path on every return, and its `construction` checkbox
              is one checkbox however many times it was passed. */}
          <div class="command-panel-fields">
            <For each={walkedFields()}>
              {(field) => (
                <Field
                  field={field}
                  value={props.panel.values.get(field.name)}
                  // Errors are SHOWN only once the user has tried to leave
                  // NO "required" state on the field.
                  //
                  // The machine already answers an emptied field by
                  // walking back to the step that owns it, so the panel
                  // is showing that step's question again — which says
                  // the same thing as a red message, in the place the
                  // user has to act anyway. Saying it twice makes the
                  // second one noise.
                  error={null}
                  onChange={(value) =>
                    props.onChange(setField(props.panel, field.name, value, props.definition))
                  }
                />
              )}
            </For>
          </div>

          <Transitions
            step={current()}
            // A transition is only offered once the step it leaves is
            // complete. The machine would refuse it anyway; disabling
            // says so before the click rather than after.
            blocked={props.panel.errors.length > 0}
            onApply={(transition) =>
              props.onChange(applyTransition(props.panel, transition.id, props.definition))
            }
          />
        </div>
      )}
    </Show>
  )
}



/**
 * Layout by count: one transition is a plain advance, a handful are
 * buttons, many become a dropdown. That rule lives here rather than in
 * each feature, so a feature that grows a sixth variant does not need a
 * UI change.
 */
function Transitions(props: {
  readonly step: CommandStep
  readonly blocked: boolean
  readonly onApply: (transition: StepTransition) => void
}) {
  const layout = createMemo(() => {
    const count = props.step.transitions.length
    if (count <= 1) return "single"
    return count <= 4 ? "buttons" : "dropdown"
  })

  return (
    <footer class="command-panel-transitions" data-layout={layout()}>
      <For each={props.step.transitions}>
        {(transition) => (
          <button
            class="transition-button"
            // A terminal transition ends the command; mark it so the
            // "Finish" of a draft reads differently from "Line".
            data-terminal={transition.to === ""}
            disabled={props.blocked}
            // Hovering shows the result before the click. The server
            // computes it coarsely and throws it away: it never enters
            // the tree. Pending the viewer.
            onClick={() => props.onApply(transition)}
          >
            {transition.label}
          </button>
        )}
      </For>
    </footer>
  )
}

/**
 * The whole feature-to-widget mapping. Nine cases, closed on purpose: a
 * feature wanting a tenth widget is asking for a special case, and
 * special cases are what this design exists to prevent.
 */
function Field(props: {
  readonly field: FieldDefinition
  readonly value: unknown
  readonly error: string | null
  readonly onChange: (value: unknown) => void
}) {
  // Every widget takes the same three inputs plus onChange. The narrowing
  // is on `field.kind`, and each Match hands the widget the field already
  // narrowed to the shape it declares.
  const common = {
    get value() { return props.value },
    get error() { return props.error },
    onChange: (value: unknown) => props.onChange(value),
  }

  return (
    <div class="field" data-invalid={props.error !== null}>
      <Switch>
        <Match when={props.field.kind === "expression" && props.field}>
          {(field) => <NumberWithUnit field={field()} {...common} />}
        </Match>
        <Match when={props.field.kind === "boolean" && props.field}>
          {(field) => <Checkbox field={field()} {...common} />}
        </Match>
        <Match when={props.field.kind === "choice" && props.field}>
          {(field) => <ButtonGroup field={field()} {...common} />}
        </Match>
        <Match when={props.field.kind === "selector" && props.field}>
          {(field) => <ViewportPicker field={field()} {...common} />}
        </Match>
        <Match when={props.field.kind === "direction" && props.field}>
          {(field) => <DirectionPicker field={field()} {...common} />}
        </Match>
        <Match when={props.field.kind === "plane" && props.field}>
          {(field) => <PlanePicker field={field()} {...common} />}
        </Match>
        <Match when={props.field.kind === "reference" && props.field}>
          {(field) => <FeatureList field={field()} {...common} />}
        </Match>
        <Match when={props.field.kind === "point-list" && props.field}>
          {(field) => <PointList field={field()} {...common} />}
        </Match>
        <Match when={props.field.kind === "table" && props.field}>
          {(field) => <Grid field={field()} {...common} />}
        </Match>
      </Switch>

      <Show when={props.error}>
        {(message) => <p class="field-error">{message()}</p>}
      </Show>
    </div>
  )
}
