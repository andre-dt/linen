// =====================================================================
// apps/web/widgets/plane-picker.tsx
//
// Standard planes, a planar face, or either of those offset. Picking a
// FACE rather than a plane keeps the reference live: move the body and
// the sketch follows.
// =====================================================================

import { Show } from "solid-js"
import { MousePointerClick, MoveVertical } from "lucide-solid"
import type { PlaneField } from "@linen/cad/features"

interface Props {
  readonly field: PlaneField
  readonly value: unknown
  readonly error: string | null
}

export function PlanePicker(props: Props) {
  return (
    <div class="widget widget-plane">
      <span class="widget-label">{props.field.label}</span>
      <div class="plane-row">
        <button class="plane-standard">XY</button>
        <button class="plane-standard">XZ</button>
        <button class="plane-standard">YZ</button>

        <Show when={props.field.allowFace}>
          <button class="plane-pick" aria-label="Pick a planar face">
            <MousePointerClick size={14} />
          </button>
        </Show>

        <Show when={props.field.allowOffset}>
          <button class="plane-offset" aria-label="Offset">
            <MoveVertical size={14} />
          </button>
        </Show>
      </div>
    </div>
  )
}
