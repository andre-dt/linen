// =====================================================================
// apps/web/panels/feature-tree.tsx
//
// The model's history, in order. Clicking a feature edits it; the
// rollback marker deactivates everything below it without deleting
// anything.
//
// Status comes from the server, never from guessing here: a feature can
// fail and the model still stands, so the tree has to show which ones
// did.
// =====================================================================

import { For, Show } from "solid-js"
import * as Icons from "lucide-solid"
import type { FeatureSummary } from "@linen/protocol"
import type { Session } from "../session"

interface FeatureTreeProps {
  readonly session: Session
}

export function FeatureTree(props: FeatureTreeProps) {
  return (
    <section class="feature-tree">
      <header class="sidebar-header">
        <Icons.ListTree size={14} />
        <span>Features</span>
      </header>

      <Show
        when={props.session.tree().length > 0}
        fallback={<p class="sidebar-empty">Draw something to begin</p>}
      >
        <ul class="feature-list-tree">
          <For each={props.session.tree()}>
            {(feature) => <FeatureRow feature={feature} />}
          </For>
        </ul>
      </Show>
    </section>
  )
}

function FeatureRow(props: { readonly feature: FeatureSummary }) {
  return (
    <li
      class="feature-row"
      data-status={props.feature.status}
      data-suppressed={props.feature.suppressed}
    >
      <StatusIcon status={props.feature.status} />
      <span class="feature-row-label">{props.feature.label}</span>
      <button class="feature-row-suppress" aria-label="Suppress">
        <Show when={props.feature.suppressed} fallback={<Icons.Eye size={12} />}>
          <Icons.EyeOff size={12} />
        </Show>
      </button>
    </li>
  )
}

function StatusIcon(props: { readonly status: FeatureSummary["status"] }) {
  return (
    <Show when={props.status !== "ok"} fallback={<Icons.Circle size={10} />}>
      <Show
        when={props.status === "error"}
        fallback={<Icons.AlertTriangle size={12} class="status-warning" />}
      >
        <Icons.CircleAlert size={12} class="status-error" />
      </Show>
    </Show>
  )
}
