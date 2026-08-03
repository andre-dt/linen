// =====================================================================
// apps/web/widgets/viewport-picker.tsx
//
// The most important widget: it decides what is clickable in the 3D
// view.
//
// The field declares what it ACCEPTS, so an "up to face" step cannot
// select an edge by accident. That constraint comes from metadata, not
// from logic written here — which is why it holds for every future
// feature too.
//
// While this field has focus, the viewer dims everything that is not a
// valid candidate. Candidates are resolved server-side, so the client
// never re-implements selection semantics.
//
// The BOX reports how many entities are picked; the PANEL lists them, so
// a selection of thirty faces does not push the rest of the command off
// the screen. See widgets/field-parts.tsx.
// =====================================================================

import { createSignal, Show, For } from "solid-js"
import type { SelectorField } from "@linen/cad/features"
import {
  FieldRoot, FieldBox, FieldClear, FieldIconButton, FieldPanelTrigger,
  FieldPanel, FieldPanelHeader,
} from "./field-parts"

interface Props {
  readonly field: SelectorField
  readonly value: unknown
  readonly error: string | null
  readonly onChange?: (value: unknown) => void
}

export function ViewportPicker(props: Props) {
  // Arming is local: it is which field the viewport is currently feeding,
  // not part of the command's value.
  const [armed, setArmed] = createSignal(false)

  const picked = (): readonly string[] =>
    Array.isArray(props.value) ? (props.value as readonly string[]) : []

  const prompt = (): string =>
    props.field.cardinality === "one"
      ? `Select a ${props.field.accepts.join(" or ")}`
      : `Select ${props.field.accepts.join(" or ")}s`

  const summary = (): string => {
    const count = picked().length
    if (count === 1) return picked()[0]!
    return `${count} selected`
  }

  const remove = (entity: string): void =>
    props.onChange?.(picked().filter((current) => current !== entity))

  return (
    <div class="widget widget-picker" data-active={armed()}>
      <span class="widget-label">{props.field.label}</span>

      <FieldRoot
        invalid={props.error !== null}
        // An EMPTY list is no value: a picker the user has emptied must
        // read the same as one never touched, or the step would count it
        // as answered.
        value={picked().length > 0 ? picked() : undefined}
        onCommit={(value) => props.onChange?.(value)}
        onClear={() => props.onChange?.([])}
      >
        <FieldBox
          control={
            <Show
              when={picked().length > 0}
              fallback={<span class="field-value empty">{prompt()}</span>}
            >
              <span class="field-value">{summary()}</span>
            </Show>
          }
        >
          <FieldClear label="Clear selection" />
          {/* Arming is the field's own action, and the common one — it
              stays in the box rather than behind the chevron. */}
          <FieldIconButton
            label={armed() ? "Stop picking" : "Pick in the viewport"}
            icon="mouse-pointer-click"
            active={armed()}
            onClick={() => setArmed((current) => !current)}
          />
          <FieldPanelTrigger label="Selected entities" />
        </FieldBox>

        <FieldPanel>
          <FieldPanelHeader>
            <FieldIconButton
              label="Clear selection"
              icon="trash-2"
              onClick={() => props.onChange?.([])}
            />
          </FieldPanelHeader>

          <Show
            when={picked().length > 0}
            fallback={<p class="field-panel-empty">{prompt()} in the viewport.</p>}
          >
            <ul class="field-panel-items">
              <For each={picked()}>
                {(entity) => (
                  <li class="field-panel-item">
                    <span class="field-panel-item-name">{entity}</span>
                    <FieldIconButton
                      label={`Remove ${entity}`}
                      icon="x"
                      onClick={() => remove(entity)}
                    />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </FieldPanel>
      </FieldRoot>
    </div>
  )
}
