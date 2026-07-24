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
// =====================================================================

import { createSignal, Show, For } from "solid-js"
import * as Icons from "lucide-solid"
import type { SelectorField } from "@linen/cad/features"

interface Props {
  readonly field: SelectorField
  readonly value: unknown
  readonly error: string | null
}

export function ViewportPicker(props: Props) {
  const [picked, setPicked] = createSignal<readonly string[]>([])
  const [active, setActive] = createSignal(false)

  const prompt = () =>
    props.field.cardinality === "one"
      ? `Select a ${props.field.accepts.join(" or ")}`
      : `Select ${props.field.accepts.join(" or ")}s`

  return (
    <div class="widget widget-picker" data-active={active()}>
      <span class="widget-label">{props.field.label}</span>

      <button
        class="picker-target"
        onClick={() => setActive((current) => !current)}
        aria-pressed={active()}
      >
        <Icons.MousePointerClick size={14} />
        <Show when={picked().length > 0} fallback={<span class="picker-prompt">{prompt()}</span>}>
          <span class="picker-count">
            {picked().length} selected
          </span>
        </Show>
      </button>

      <Show when={picked().length > 0}>
        <ul class="picker-items">
          <For each={picked()}>
            {(entity) => (
              <li class="picker-item">
                <span>{entity}</span>
                <button
                  class="picker-remove"
                  onClick={() => setPicked((current) => current.filter((e) => e !== entity))}
                  aria-label="Remove"
                >
                  <Icons.X size={12} />
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
