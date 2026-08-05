// =====================================================================
// apps/web/widgets/number-with-unit.tsx
//
// NOT a number input. It accepts an EXPRESSION, which is the reason the
// model is parametric at all: typing `outerDiameter / 2` stores the
// relationship, so changing outerDiameter later moves the geometry.
// Storing `60` would silently sever it.
//
// The text is kept verbatim. A round trip through this widget must
// never rewrite the user's formula into a normalised form they did not
// type.
//
// Built from the shared field parts, so it is the same box and the same
// button sizes as every other field — see widgets/field-parts.tsx. Its
// panel holds what a formula needs and a bare number does not: the unit,
// the declared range, and the evaluated result.
// =====================================================================

import { createMemo, Show } from "solid-js"
import type { ExpressionField } from "@linen/cad/features"
import {
  FieldRoot, FieldBox, FieldClear, FieldPanelTrigger, FieldPanel,
} from "./field-parts"
import { WidgetLabel } from "./widget-label"

interface Props {
  readonly field: ExpressionField
  readonly value: unknown
  readonly error: string | null
  readonly onChange?: (value: unknown) => void
}

const UNIT: Record<string, string> = {
  length: "mm",
  angle: "°",
  count: "",
  scalar: "",
}

export function NumberWithUnit(props: Props) {
  // The panel owns the text. Storing it here too would let the two
  // disagree the moment a step is revisited — and the stored form is
  // exactly what must survive, since it is the user's formula.
  const text = createMemo(() => (props.value === undefined ? "" : String(props.value)))

  // Evaluation belongs to the expression engine, which lands with the
  // kernel. Until then a formula shows no result rather than a guess.
  const evaluated = (): number | null => null

  const unit = createMemo(() => UNIT[props.field.dimension] ?? "")

  // An expression is anything that is not a bare number. Showing the
  // evaluated result beside it is what keeps a formula legible.
  const isFormula = createMemo(() => text().trim() !== "" && Number.isNaN(Number(text())))

  const range = createMemo(() => {
    const { minimum, maximum } = props.field
    if (minimum === null && maximum === null) return null
    if (minimum !== null && maximum !== null) return `${minimum} to ${maximum}`
    return minimum !== null ? `at least ${minimum}` : `at most ${maximum}`
  })

  return (
    <div class="widget widget-number">
      <WidgetLabel label={props.field.label} help={props.field.help} />

      <FieldRoot
        invalid={props.error !== null}
        // Empty text is NO VALUE, not the empty string: a cleared field
        // must be indistinguishable from one never filled, or the step
        // would count it as answered.
        value={text() === "" ? undefined : text()}
        onCommit={(value) => props.onChange?.(value)}
      >
        <FieldBox
          control={
            <input
              class="field-control"
              value={text()}
              placeholder={props.field.optional ? "auto" : ""}
              onInput={(event) => props.onChange?.(event.currentTarget.value)}
              inputmode="text"
              spellcheck={false}
            />
          }
        >
          {/* The unit is part of reading the value, not a control, so it
              sits with the text rather than in the button cluster. */}
          <Show when={unit()}>
            <span class="field-unit">{unit()}</span>
          </Show>
          <FieldClear label="Clear value" />
          <FieldPanelTrigger label="Value details" />
        </FieldBox>

        <FieldPanel>
          <dl class="field-panel-facts">
            <Show when={unit()}>
              <dt>Unit</dt>
              <dd>{unit()}</dd>
            </Show>
            <Show when={range()}>
              {(bounds) => (
                <>
                  <dt>Range</dt>
                  <dd>{bounds()}</dd>
                </>
              )}
            </Show>
            <Show when={isFormula()}>
              <dt>Evaluates to</dt>
              {/* No expression engine yet, so a formula says so rather
                  than showing a guess at its value. */}
              <dd>{evaluated() ?? "pending the kernel"}</dd>
            </Show>
          </dl>

          <Show when={props.field.help}>
            {(help) => <p class="field-panel-empty">{help()}</p>}
          </Show>
        </FieldPanel>
      </FieldRoot>
    </div>
  )
}
