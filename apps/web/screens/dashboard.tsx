// =====================================================================
// apps/web/screens/dashboard.tsx — projects & parts, as a HUD.
//
// Not a page with panes but a CANVAS with panels floating over it: the
// same language as the editor, so moving from picking a part to editing
// it is a continuation, not a context switch. Panels are frosted, pinned
// to the viewport edges, and never push the canvas around.
//
//   ┌───────────────────────────────────────────────────────┐
//   │ ◆ Linen                                    [account ⌄] │  ← top rail
//   │ ┌───────────┐  ┌───────────┐                           │
//   │ │ Projects  │  │ <project> │                           │
//   │ │ · · ·     │  │ parts…    │      (canvas behind)      │
//   │ └───────────┘  └───────────┘                           │
//   └───────────────────────────────────────────────────────┘
//
// State is local: three signals (projects, selected project, its parts).
// The projects.ts client does the I/O; nothing global holds this data.
// =====================================================================

import { createSignal, For, Show, onMount, onCleanup } from "solid-js"
import { useNavigate } from "@solidjs/router"
import type { Auth } from "../auth"
import {
  listProjects, createProject, archiveProject,
  type ProjectView,
} from "../projects"
import { Drawer } from "../widgets/drawer"

export function Dashboard(props: { auth: Auth }) {
  const navigate = useNavigate()
  const [projects, setProjects] = createSignal<readonly ProjectView[]>([])
  const [error, setError] = createSignal<string | null>(null)
  // The project whose "…" options menu is open (by id), or null.
  const [menuFor, setMenuFor] = createSignal<string | null>(null)

  // A click anywhere else closes an open options menu.
  const closeMenu = (): void => {
    setMenuFor(null)
  }
  document.addEventListener("click", closeMenu)
  onCleanup(() => document.removeEventListener("click", closeMenu))

  // The new-project drawer: whether it is open, and the name being typed.
  const [drawerOpen, setDrawerOpen] = createSignal(false)
  const [name, setName] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  const guard = async (work: () => Promise<void>): Promise<void> => {
    try {
      setError(null)
      await work()
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  onMount(() => {
    void guard(async () => {
      setProjects(await listProjects())
    })
  })

  // Selecting a project routes to its screen — the URL becomes the state.
  const openProject = (project: ProjectView): void => navigate(`/project/${project.id}`)

  const openDrawer = (): void => {
    setName("")
    setDrawerOpen(true)
  }
  const closeDrawer = (): void => {
    setDrawerOpen(false)
  }

  const save = (): Promise<void> =>
    guard(async () => {
      const trimmed = name().trim()
      if (!trimmed) return
      setSaving(true)
      try {
        const project = await createProject(trimmed)
        closeDrawer()
        openProject(project)
      } finally {
        setSaving(false)
      }
    })

  const archive = (project: ProjectView): Promise<void> =>
    guard(async () => {
      closeMenu()
      await archiveProject(project.id, true)
      setProjects(projects().filter((candidate) => candidate.id !== project.id))
    })

  return (
    <div class="hud-scene">
      {/* the plain white field the panels float over */}
      <div class="hud-canvas" />

      {/* top-right: the signed-in account */}
      <div class="hud-slot hud-top-right">
        <Show when={props.auth.account()}>
          {(account) => (
            <div class="hud-panel hud-profile">
              <Show
                when={account().picture}
                fallback={<span class="hud-avatar">{initial(account().name)}</span>}
              >
                {(picture) => (
                  <img
                    class="hud-avatar-image"
                    src={picture()}
                    alt=""
                    // Google's lh3.googleusercontent.com avatars 403 when a
                    // referrer is sent; suppress it so the image loads.
                    referrerpolicy="no-referrer"
                    // If it still fails, fall back to the initial rather than
                    // showing a broken-image icon.
                    onError={(event) => {
                      const image = event.currentTarget
                      const badge = document.createElement("span")
                      badge.className = "hud-avatar"
                      badge.textContent = initial(account().name)
                      image.replaceWith(badge)
                    }}
                  />
                )}
              </Show>
              <span class="hud-profile-name">{account().name}</span>
              <button class="hud-button subtle" onClick={() => props.auth.signOut()}>
                Sign out
              </button>
            </div>
          )}
        </Show>
      </div>

      {/* the projects panel, pinned below the top rail on the left */}
      <div class="hud-slot hud-workspace">
        <section class="hud-panel hud-list-panel">
          <header class="hud-list-head">
            <h2>Projects</h2>
            <button class="hud-button" onClick={openDrawer}>New</button>
          </header>
          <ul class="hud-list">
            <For each={projects()} fallback={<li class="hud-empty">No projects yet.</li>}>
              {(project) => (
                <li class="hud-item" onClick={() => openProject(project)}>
                  <span class="hud-item-name">{project.name}</span>

                  {/* "…" options. stopPropagation so opening the menu does
                      not also open the project. */}
                  <div class="hud-item-menu" onClick={(event) => event.stopPropagation()}>
                    <button
                      class="hud-item-more"
                      aria-label="Project options"
                      onClick={() => setMenuFor(menuFor() === project.id ? null : project.id)}
                    >
                      …
                    </button>
                    <Show when={menuFor() === project.id}>
                      <div class="hud-menu">
                        <button class="hud-menu-item" onClick={() => void archive(project)}>
                          Archive
                        </button>
                      </div>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </section>
      </div>

      <Show when={error()}>
        {(message) => (
          <div class="hud-slot hud-bottom">
            <div class="hud-panel hud-toast">{message()}</div>
          </div>
        )}
      </Show>

      {/* New project: a drawer sliding in from the right. */}
      <Drawer
        open={drawerOpen()}
        title="New project"
        saveLabel={saving() ? "Saving…" : "Save"}
        canSave={name().trim().length > 0 && !saving()}
        onSave={() => void save()}
        onClose={closeDrawer}
      >
        <label class="drawer-field">
          <span class="drawer-label">Name</span>
          <input
            class="drawer-input"
            autofocus
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
      </Drawer>
    </div>
  )
}

const initial = (name: string): string => (name.trim()[0] ?? "?").toUpperCase()
