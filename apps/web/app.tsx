// =====================================================================
// apps/web/src/app.tsx — the shell.
//
// Layout only. Every panel below is generic: none of them knows what an
// extrude is, and adding a feature touches none of this file.
//
//   +--------------------------------------------------+
//   | toolbar                                          |
//   +----------+---------------------------------------+
//   | feature  |                                       |
//   | tree     |            canvas (3D)                |
//   |          |                                       |
//   | vars     |          +-----------------+          |
//   |          |          | command panel   |          |
//   |          |          | (floating)      |          |
//   +----------+----------+-----------------+----------+
//   | status                                           |
//   +--------------------------------------------------+
//
// THE REACTIVE BOUNDARY
// ---------------------
// Solid signals own panel state: which step, which values, which field
// has focus. They never own GPU state.
//
// The canvas is imperative and lives outside the reactive graph — a
// signal driving buffer uploads would re-run on every unrelated change
// and destroy the frame budget. The panel publishes intent; the viewer
// acts on it.
// =====================================================================

import { Show } from "solid-js"
import { Viewport } from "./viewport"
import { Toolbar } from "./panels/toolbar"
import { FeatureTree } from "./panels/feature-tree"
import { Variables } from "./panels/variables"
import { CommandPanel } from "./panels/command-panel"
import { StatusBar } from "./panels/status-bar"
import { useSession } from "./session"

export function App() {
  const session = useSession()

  return (
    <div class="app">
      <Toolbar session={session} />

      <div class="app-body">
        <aside class="sidebar">
          <FeatureTree session={session} />
          <Variables session={session} />
        </aside>

        <main class="viewport-host">
          <Viewport session={session} />

          {/* Floats over the canvas rather than displacing it: resizing
              the panel must never resize the canvas, which would force
              a re-render for no reason. */}
          <Show when={session.panel()}>
            {(panel) => <CommandPanel panel={panel()} session={session} />}
          </Show>
        </main>
      </div>

      <StatusBar session={session} />
    </div>
  )
}
