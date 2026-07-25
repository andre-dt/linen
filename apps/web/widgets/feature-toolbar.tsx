// =====================================================================
// apps/web/widgets/feature-toolbar.tsx — every feature, as icons.
//
// A plugin scan: it introspects the command registry (standardPreset)
// and renders EVERY command as an icon — no hand-written list, no
// categories. Add a feature to the preset and it appears here on its
// own. Commands are flattened across features and sorted alphabetically
// by label, so position is derived from the metadata, never assigned.
//
// The icon comes from each command's own `icon` metadata (a lucide name),
// resolved dynamically by LucideIcon — no name→component map.
//
// KEYSTROKES
// ----------
// Each command SUGGESTS a shortcut in its metadata; it can be anything.
// Suggestions collide, so we resolve them: walking the commands in their
// display order, the first to ask for a key keeps it and every later
// command wanting the same key is left with none. The resolved key is
// shown in the tooltip. Actually ACTIVATING via the keyboard is left for
// later — only the resolution and display live here for now.
// =====================================================================

import { For, createMemo } from "solid-js"
import { Tooltip } from "@ark-ui/solid/tooltip"
import { standardPreset } from "@linen/cad/features"
import type { CommandDefinition } from "@linen/cad/features"
import { LucideIcon } from "./lucide-icon"

interface ResolvedCommand {
  readonly command: CommandDefinition<never, never>
  /** The key this command actually owns after conflict resolution, or
   *  null if a higher-priority command already claimed its suggestion. */
  readonly key: string | null
}

export function FeatureToolbar(props: {
  onActivate?: (command: CommandDefinition<never, never>) => void
}) {
  // Flatten every command, order by label, then resolve shortcuts.
  const resolved = createMemo<readonly ResolvedCommand[]>(() => {
    const commands = standardPreset
      .flatMap((feature) => feature.commands as readonly CommandDefinition<never, never>[])
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label))

    const taken = new Set<string>()
    return commands.map((command) => {
      const suggested = command.shortcut?.toLowerCase() ?? null
      if (suggested && !taken.has(suggested)) {
        taken.add(suggested)
        return { command, key: suggested }
      }
      // No suggestion, or the key is already taken: this one gets none.
      return { command, key: null }
    })
  })

  // Actually binding these keys to activation is deferred to a future
  // KeyStrokeProvider, which will own all shortcut handling in one place
  // (registration, conflict policy, scoping) rather than each component
  // wiring its own document listener. Here we only resolve and display.

  return (
    <div class="hud-panel hud-toolbar">
      <For each={resolved()}>
        {(entry) => (
          <Tooltip.Root openDelay={400}>
            <Tooltip.Trigger
              class="hud-tool"
              aria-label={entry.command.label}
              onClick={() => props.onActivate?.(entry.command)}
            >
              <LucideIcon name={entry.command.icon} size={18} />
            </Tooltip.Trigger>
            <Tooltip.Positioner>
              <Tooltip.Content class="tooltip">
                {entry.key
                  ? `${entry.command.label} (${entry.key.toUpperCase()})`
                  : entry.command.label}
              </Tooltip.Content>
            </Tooltip.Positioner>
          </Tooltip.Root>
        )}
      </For>
    </div>
  )
}
