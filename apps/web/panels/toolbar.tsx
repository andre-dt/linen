// =====================================================================
// apps/web/panels/toolbar.tsx
//
// Derived from the command definitions in the preset, grouped by
// `group`. There is no hand-written list of features anywhere — that
// would be one more thing to forget when adding one.
//
// An entry greys out when the connected kernel lacks a capability the
// command requires, with the reason in the tooltip. Better to disable it
// up front than to let the user fill in four steps and fail at execute.
// =====================================================================

import { For, createMemo } from "solid-js"
import { commandIcon } from "../icons"
import { Tooltip } from "@ark-ui/solid/tooltip"
import type { CommandDefinition, ToolbarGroup } from "@linen/cad/features"
import type { Session } from "../session"

interface ToolbarProps {
  readonly session: Session
}

const GROUP_ORDER: readonly ToolbarGroup[] = [
  "sketch", "create", "modify", "pattern", "assemble", "measure",
]

export function Toolbar(props: ToolbarProps) {
  const capabilities = createMemo(
    () => new Set(props.session.info()?.capabilities ?? []),
  )

  const groups = createMemo(() => {
    const byGroup = new Map<ToolbarGroup, CommandDefinition<never, never>[]>()
    for (const definition of props.session.definitions()) {
      const list = byGroup.get(definition.group) ?? []
      list.push(definition)
      byGroup.set(definition.group, list)
    }
    return GROUP_ORDER
      .map((group) => ({ group, commands: byGroup.get(group) ?? [] }))
      .filter((entry) => entry.commands.length > 0)
  })

  return (
    <header class="toolbar">
      <For each={groups()}>
        {(entry) => (
          <div class="toolbar-group">
            <For each={entry.commands}>
              {(definition) => (
                <ToolbarButton
                  definition={definition}
                  capabilities={capabilities()}
                  onActivate={() => props.session.beginCommand(definition)}
                />
              )}
            </For>
          </div>
        )}
      </For>
    </header>
  )
}

interface ToolbarButtonProps {
  readonly definition: CommandDefinition<never, never>
  readonly capabilities: ReadonlySet<string>
  readonly onActivate: () => void
}

function ToolbarButton(props: ToolbarButtonProps) {
  const missing = createMemo(() =>
    props.definition.requires.filter((id) => !props.capabilities.has(id)),
  )

  const label = createMemo(() => {
    const gaps = missing()
    if (gaps.length === 0) {
      const shortcut = props.definition.shortcut
      return shortcut
        ? `${props.definition.label} (${shortcut.toUpperCase()})`
        : props.definition.label
    }
    return `${props.definition.label} — kernel lacks ${gaps.join(", ")}`
  })

  return (
    <Tooltip.Root openDelay={400}>
      <Tooltip.Trigger
        class="toolbar-button"
        disabled={missing().length > 0}
        onClick={props.onActivate}
        aria-label={props.definition.label}
      >
        {commandIcon(props.definition.icon)({ size: 18 })}
      </Tooltip.Trigger>
      <Tooltip.Positioner>
        <Tooltip.Content class="tooltip">{label()}</Tooltip.Content>
      </Tooltip.Positioner>
    </Tooltip.Root>
  )
}

