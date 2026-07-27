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
// =====================================================================

import { For, Show, Switch, Match, createMemo } from "solid-js"
import { X } from "../icons"
import {
  setField, applyTransition, stepTo,
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

export function CommandPanel(props: CommandPanelProps) {
  const step = createMemo<CommandStep | undefined>(() =>
    props.definition.steps.find((entry) => entry.id === props.panel.currentStep),
  )

  return (
    <Show when={step()}>
      {(current) => (
        <div class="command-panel">
          <header class="command-panel-header">
            <span class="command-panel-title">{props.definition.label}</span>
            <button class="command-panel-close" onClick={props.onClose} aria-label="Close">
              <X size={14} />
            </button>
          </header>

          {/* Breadcrumb of steps already walked. Clicking one goes back
              without discarding the command — undo per step. */}
          <Show when={props.panel.path.length > 0}>
            <nav class="command-panel-path">
              <For each={props.panel.path}>
                {(id) => (
                  <button
                    class="command-panel-crumb"
                    onClick={() => props.onChange(stepTo(props.panel, id, props.definition))}
                  >
                    {labelOfStep(props.definition, id)}
                  </button>
                )}
              </For>
              <span class="command-panel-crumb current">{current().label}</span>
            </nav>
          </Show>

          <Show when={current().help}>
            {(help) => <p class="command-panel-help">{help()}</p>}
          </Show>

          <div class="command-panel-fields">
            <For each={current().fields}>
              {(field) => (
                <Field
                  field={field}
                  value={props.panel.values.get(field.name)}
                  error={props.panel.errors.find((e) => e.field === field.name)?.message ?? null}
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

const labelOfStep = (definition: CommandDefinition<never, never>, id: string): string =>
  definition.steps.find((step) => step.id === id)?.label ?? id

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
