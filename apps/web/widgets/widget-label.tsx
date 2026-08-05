// =====================================================================
// apps/web/widgets/widget-label.tsx — A FIELD'S NAME, AND ITS HELP.
//
// One component for all ten widgets, because a label is the same thing
// in every one of them: the field's name, with its `help` as a tooltip
// when the metadata has one.
//
// WHY THE HELP IS A TOOLTIP AND NOT A LINE OF TEXT
// ------------------------------------------------
// Help used to render as a `<span>` under the control. That text is a
// BLOCK: it appears when a field appears and disappears when it goes,
// so every step the machine walks moves everything below it. The panel
// advances on a click — sometimes two steps at once — and a layout that
// jumps on each move is a layout the user cannot aim at.
//
// A tooltip occupies no layout at all.
//
// NOTHING MARKS A LABEL THAT HAS ONE
// ----------------------------------
// No icon, no underline, no cursor change. A field with help and a
// field without look and behave identically; the tooltip is something
// found on hover rather than advertised. An indicator on some labels
// and not others makes those fields read as special, when the only
// difference is that someone wrote a sentence about them.
// =====================================================================

import { Show } from "solid-js"
import { Tooltip } from "@ark-ui/solid/tooltip"

export function WidgetLabel(props: {
  readonly label: string
  readonly help?: string | null
}) {
  return (
    <Show
      when={props.help}
      fallback={<span class="widget-label">{props.label}</span>}
    >
      {(help) => (
        <Tooltip.Root openDelay={300}>
          {/* `asChild` so Ark wires its handlers onto this span rather
              than rendering a button of its own — a button brings a
              focus ring, a tab stop and a pointer cursor, none of which
              belong on a label. */}
          <Tooltip.Trigger asChild={(local) => (
            <span {...local()} class="widget-label">{props.label}</span>
          )} />
          <Tooltip.Positioner>
            <Tooltip.Content class="tooltip">{help()}</Tooltip.Content>
          </Tooltip.Positioner>
        </Tooltip.Root>
      )}
    </Show>
  )
}
