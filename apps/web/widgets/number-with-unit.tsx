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
// =====================================================================

import { createSignal, createMemo, Show } from "solid-js"
import type { ExpressionField } from "@linen/cad/features"

interface Props {
  readonly field: ExpressionField
  readonly value: unknown
  readonly error: string | null
}

const UNIT: Record<string, string> = {
  length: "mm",
  angle: "°",
  count: "",
  scalar: "",
}

export function NumberWithUnit(props: Props) {
  const [text, setText] = createSignal("")
  const [evaluated, setEvaluated] = createSignal<number | null>(null)

  const unit = createMemo(() => UNIT[props.field.dimension] ?? "")

  // An expression is anything that is not a bare number. Showing the
  // evaluated result beside it is what keeps a formula legible.
  const isFormula = createMemo(() => text().trim() !== "" && Number.isNaN(Number(text())))

  return (
    <label class="widget widget-number">
      <span class="widget-label">{props.field.label}</span>

      <div class="widget-input-row">
        <input
          class="widget-input"
          value={text()}
          placeholder={props.field.optional ? "auto" : ""}
          onInput={(event) => setText(event.currentTarget.value)}
          inputmode="text"
          spellcheck={false}
        />
        <Show when={unit()}>
          <span class="widget-unit">{unit()}</span>
        </Show>
      </div>

      {/* The evaluated value, greyed. Only shown for formulas: echoing
          "12" under a field that says 12 is noise. */}
      <Show when={isFormula() && evaluated() !== null}>
        <span class="widget-evaluated">= {evaluated()} {unit()}</span>
      </Show>

      <Show when={props.field.help}>
        {(help) => <span class="widget-help">{help()}</span>}
      </Show>
    </label>
  )
}
