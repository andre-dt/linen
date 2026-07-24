// =====================================================================
// apps/web/panels/status-bar.tsx
//
// Connection, diagnostics and regeneration time.
//
// Regeneration time is here on purpose: it is the number that tells you
// a model has become slow, and it belongs in view rather than in a
// profiler. A part that takes eight seconds to rebuild is a design
// problem the user can act on.
// =====================================================================

import { Show, createMemo } from "solid-js"
import { AlertTriangle, CircleAlert, Cloud, CloudOff } from "../icons"
import type { Session } from "../session"

interface StatusBarProps {
  readonly session: Session
}

export function StatusBar(props: StatusBarProps) {
  const connection = createMemo(() => props.session.connection())

  const errors = createMemo(
    () => props.session.diagnostics().filter((entry) => entry.severity === "error"),
  )
  const warnings = createMemo(
    () => props.session.diagnostics().filter((entry) => entry.severity === "warning"),
  )

  return (
    <footer class="status-bar">
      <span class="status-connection" data-state={connection().kind}>
        <Show
          when={connection().kind === "open"}
          fallback={<CloudOff size={12} />}
        >
          <Cloud size={12} />
        </Show>
        {connection().kind}
      </span>

      <Show when={errors().length > 0}>
        <span class="status-errors">
          <CircleAlert size={12} /> {errors().length}
        </span>
      </Show>

      <Show when={warnings().length > 0}>
        <span class="status-warnings">
          <AlertTriangle size={12} /> {warnings().length}
        </span>
      </Show>

      <span class="status-spacer" />

      <Show when={props.session.regenerationMilliseconds()}>
        {(elapsed) => (
          <span class="status-timing" data-slow={elapsed() > 2000}>
            {elapsed()} ms
          </span>
        )}
      </Show>

      <Show when={props.session.info()}>
        {(info) => (
          <span class="status-kernel">
            {info().kernel.name} {info().kernel.version}
          </span>
        )}
      </Show>
    </footer>
  )
}
