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
// =====================================================================

import { For, Show, Switch, Match, createMemo } from "solid-js"
import * as Icons from "lucide-solid"
import type {
  CommandStep, FieldDefinition, StepTransition, PanelState,
} from "@linen/cad/features"
import type { Session } from "../session"
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
  readonly session: Session
}

export function CommandPanel(props: CommandPanelProps) {
  const definition = createMemo(() =>
    props.session.definitions().find((entry) => entry.id === props.panel.command),
  )

  const step = createMemo(() =>
    definition()?.steps.find((entry) => entry.id === props.panel.currentStep),
  )

  return (
    <Show when={definition() && step()}>
      <div class="command-panel">
        <header class="command-panel-header">
          <span class="command-panel-title">{definition()!.label}</span>
          <button
            class="command-panel-close"
            onClick={() => props.session.cancelCommand()}
            aria-label="Cancel"
          >
            <Icons.X size={14} />
          </button>
        </header>

        {/* Breadcrumb of steps already walked. Clicking one goes back
            without discarding the command — undo per step. */}
        <Show when={props.panel.path.length > 0}>
          <nav class="command-panel-path">
            <For each={props.panel.path}>
              {(id) => <span class="command-panel-crumb">{id}</span>}
            </For>
          </nav>
        </Show>

        <Show when={step()!.help}>
          {(help) => <p class="command-panel-help">{help()}</p>}
        </Show>

        <div class="command-panel-fields">
          <For each={step()!.fields}>
            {(field) => (
              <Field
                field={field}
                value={props.panel.values.get(field.name)}
                error={props.panel.errors.find((e) => e.field === field.name)?.message ?? null}
              />
            )}
          </For>
        </div>

        <Transitions step={step()!} />
      </div>
    </Show>
  )
}

/**
 * Layout by count: one transition is a plain advance, a handful are
 * buttons, many become a dropdown. That rule lives here rather than in
 * each feature, so a feature that grows a sixth variant does not need a
 * UI change.
 */
function Transitions(props: { readonly step: CommandStep }) {
  const layout = createMemo(() => {
    const count = props.step.transitions.length
    if (count <= 1) return "single"
    return count <= 4 ? "buttons" : "dropdown"
  })

  return (
    <footer class="command-panel-transitions" data-layout={layout()}>
      <For each={props.step.transitions}>
        {(transition) => <TransitionButton transition={transition} />}
      </For>
    </footer>
  )
}

function TransitionButton(props: { readonly transition: StepTransition }) {
  return (
    <button
      class="transition-button"
      // Hovering shows the result before the click. The server computes
      // it coarsely and throws it away: it never enters the tree.
      onMouseEnter={() => props.transition.preview && undefined}
      onMouseLeave={() => props.transition.preview && undefined}
    >
      {props.transition.label}
    </button>
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
}) {
  return (
    <div class="field" data-invalid={props.error !== null}>
      <Switch>
        <Match when={props.field.kind === "expression"}>
          <NumberWithUnit {...props} />
        </Match>
        <Match when={props.field.kind === "boolean"}>
          <Checkbox {...props} />
        </Match>
        <Match when={props.field.kind === "choice"}>
          <ButtonGroup {...props} />
        </Match>
        <Match when={props.field.kind === "selector"}>
          <ViewportPicker {...props} />
        </Match>
        <Match when={props.field.kind === "direction"}>
          <DirectionPicker {...props} />
        </Match>
        <Match when={props.field.kind === "plane"}>
          <PlanePicker {...props} />
        </Match>
        <Match when={props.field.kind === "reference"}>
          <FeatureList {...props} />
        </Match>
        <Match when={props.field.kind === "point-list"}>
          <PointList {...props} />
        </Match>
        <Match when={props.field.kind === "table"}>
          <Grid {...props} />
        </Match>
      </Switch>

      <Show when={props.error}>
        {(message) => <p class="field-error">{message()}</p>}
      </Show>
    </div>
  )
}
