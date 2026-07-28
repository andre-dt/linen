// =====================================================================
// apps/web/screens/project.tsx — the project workspace at /project/:id.
//
// A full-bleed canvas with HUD panels floating over it, in the shape the
// editor will grow into. What has data today is live:
//
//   - breadcrumb (top-left): Dashboard › <project>, navigates back
//   - artifacts (left): the project's parts & modules — real parts list
//   - profile / sign out (top-right)
//   - new part: the shared right-side drawer
//
// What has no data yet carries an HONEST placeholder — never fabricated
// geometry or fake history:
//
//   - the 3D canvas
//   - the part outline (parametric CAD history)
//   - the segmented toolbar (3D ops / draft ops)
//   - view & rendering options
//   - the info panel and the bottom status bar
//
// Each is a real slot in the right place, labelled as pending, so wiring
// it later is filling a box — not rebuilding the layout.
// =====================================================================

import { createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { standardPreset, setField, type CommandDefinition } from "@linen/cad/features"
import type { PlaneHit, Scene as SceneHandle, StandardView } from "@linen/viewer"
import type { Auth } from "../auth"
import {
  getProject, listParts, createPart,
  type ProjectView, type PartView,
} from "../projects"
import { appendElement, elementsOf, removeElement, updateElement } from "../elements"
import { Drawer } from "../widgets/drawer"
import { SplitButton } from "../widgets/split-button"
import { FeatureToolbar } from "../widgets/feature-toolbar"
import { ViewCube, type ViewDirection, type ViewNudge } from "../widgets/view-cube"
import { CollapsiblePanel } from "../widgets/collapsible-panel"
import { LucideIcon } from "../widgets/lucide-icon"
import { CommandPanel } from "../panels/command-panel"
import { Viewport } from "../viewport"
import { X } from "../icons"

/** Every command from every registered feature, flattened once. The
 *  outline resolves an element's definition through this — never through
 *  a per-feature lookup, which is what keeps a new feature UI-free. */
const DEFINITIONS: readonly CommandDefinition<never, never>[] =
  standardPreset.flatMap((feature) => feature.commands)

export function Project(props: { auth: Auth }) {
  // The URL carries the selection: :kind (part|module) + :artifactId, and
  // optionally :featureUuid. There is no selection signal — the route IS
  // the state, so a refresh or a shared link lands on the same artifact.
  const params = useParams<{ id: string; kind?: string; artifactId?: string; featureUuid?: string }>()
  const navigate = useNavigate()

  const [project, setProject] = createSignal<ProjectView | null>(null)
  const [parts, setParts] = createSignal<readonly PartView[]>([])
  const [error, setError] = createSignal<string | null>(null)

  // The selected part, derived from the URL param against the loaded list.
  const selectedPart = createMemo<PartView | null>(() => {
    if (params.kind !== "part" || !params.artifactId) return null
    return parts().find((part) => part.id === params.artifactId) ?? null
  })

  // ---------------------------------------------------------------
  // The part's outline: its elements, and which one is being designed.
  // ---------------------------------------------------------------

  const elements = createMemo(() => {
    const part = selectedPart()
    return part ? elementsOf(part.id) : []
  })

  // Which element the designer is open on. A signal rather than a route
  // param: an element is not addressable until it is committed to git,
  // and a URL that outlives its target is worse than no URL. The
  // /feature/:uuid route stays as-is for the command being started.
  const [designing, setDesigning] = createSignal<string | null>(null)

  const designed = createMemo(() => elements().find((element) => element.id === designing()) ?? null)

  const definitionOf = (command: string): CommandDefinition<never, never> | undefined =>
    DEFINITIONS.find((definition) => definition.id === command)

  /**
   * Clicking a feature in the toolbar ADDS an element to the part and
   * opens its designer. The element exists from that first click — it is
   * an entry in the history being authored, not a modal that either
   * commits or vanishes.
   */
  const activateCommand = (command: CommandDefinition<never, never>): void => {
    const part = selectedPart()
    if (!part) return
    const element = appendElement(part.id, command)
    setDesigning(element.id)
  }

  // ---------------------------------------------------------------
  // What the viewport is picking, derived from the METADATA.
  //
  // The step being designed declares its fields; if one of them is a
  // plane field, the datum planes appear and become clickable. No
  // feature-specific code: any command with a plane field gets this,
  // including one a user defines later.
  // ---------------------------------------------------------------

  const planeField = createMemo(() => {
    const element = designed()
    if (!element) return null
    const definition = definitionOf(element.command)
    const step = definition?.steps.find((entry) => entry.id === element.panel.currentStep)
    return step?.fields.find((field) => field.kind === "plane") ?? null
  })

  /** The chosen plane, so the viewport keeps it lit. */
  const selectedPlaneId = createMemo<string | null>(() => {
    const field = planeField()
    const element = designed()
    if (!field || !element) return null
    const value = element.panel.values.get(field.name) as { plane?: string } | undefined
    return value?.plane ?? null
  })

  /**
   * A datum plane was clicked in the viewport. Writes the SAME value the
   * picker's buttons write — the two paths must be indistinguishable
   * downstream, or the persisted input would depend on how the user
   * happened to choose.
   */
  const acceptPlanePick = (hit: PlaneHit): void => {
    const field = planeField()
    const element = designed()
    const part = selectedPart()
    if (!field || !element || !part) return

    const definition = definitionOf(element.command)
    if (!definition) return

    updateElement(part.id, element.id, (current) => ({
      ...current,
      panel: setField(
        current.panel,
        field.name,
        {
          kind: "datum",
          plane: hit.plane.id,
          axes: hit.plane.axes,
          offset: 0,
        },
        definition,
      ),
    }))
  }

  /**
   * The view cube moves the camera.
   *
   * Held outside the reactive graph, like everything else that touches
   * the scene: this is an imperative jump, not a piece of state the DOM
   * renders. The cube's four corner cells map onto four distinct
   * isometric views rather than collapsing to one.
   */
  let sceneRef: SceneHandle | null = null

  /**
   * The camera's orientation, mirrored into the reactive graph so the
   * view cube can turn with it.
   *
   * Polled on an animation frame rather than pushed from the render
   * loop: the loop lives inside Viewport and publishing from there would
   * make every frame a reactive write. Three numbers compared per frame
   * is cheap, and the signal only fires when one actually changes — so a
   * still camera costs nothing downstream.
   */
  const [cameraAngles, setCameraAngles] = createSignal(
    { azimuth: 0, elevation: 0, roll: 0 },
    { equals: (a, b) =>
        a.azimuth === b.azimuth && a.elevation === b.elevation && a.roll === b.roll },
  )

  onMount(() => {
    let frame = 0
    const sample = (): void => {
      const camera = sceneRef?.camera
      if (camera) {
        setCameraAngles({
          azimuth: camera.azimuth,
          elevation: camera.elevation,
          roll: camera.rollAngle,
        })
      }
      frame = requestAnimationFrame(sample)
    }
    frame = requestAnimationFrame(sample)
    onCleanup(() => cancelAnimationFrame(frame))
  })

  const applyView = (direction: ViewDirection): void => {
    // Straight through as a vector: the cube's faces, edges and corners
    // are twenty-six poses, and the camera resolves any of them without
    // a lookup table here that could fall out of step with the widget.
    sceneRef?.camera.lookFrom(direction)
  }

  /**
   * The corner arrows turn the camera one step, rather than jumping to a
   * named view. `y` is screen-down while elevation is measured up, so it
   * is negated — pressing the up arrow has to raise the camera.
   */
  const nudgeView = (nudge: ViewNudge): void => {
    sceneRef?.camera.nudge(nudge.x, -nudge.y)
  }

  /** The circular arrows turn the picture in its own plane. */
  const rollView = (steps: number): void => {
    sceneRef?.camera.roll(steps)
  }

  const discardElement = (elementId: string): void => {
    const part = selectedPart()
    if (!part) return
    removeElement(part.id, elementId)
    if (designing() === elementId) setDesigning(null)
  }

  // The artifact-creation drawer: which kind, the name, and whether a
  // save is in flight. "module" is accepted here but not yet backed by
  // the store — the drawer says so rather than pretend.
  const [drawerKind, setDrawerKind] = createSignal<"part" | "module" | null>(null)
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
      // The project may not exist / not be owned: getProject 404s -> the
      // client throws, and we bounce back to the dashboard.
      const found = await getProject(params.id).catch(() => null)
      if (!found) {
        navigate("/", { replace: true })
        return
      }
      setProject(found)
      setParts(await listParts(params.id))
    })
  })

  const openDrawer = (kind: "part" | "module"): void => {
    setName("")
    setDrawerKind(kind)
  }
  const closeDrawer = (): void => {
    setDrawerKind(null)
  }

  const save = (): Promise<void> =>
    guard(async () => {
      const trimmed = name().trim()
      if (!trimmed) return
      if (drawerKind() === "module") {
        // Modules are not wired to the store yet; be honest instead of
        // creating something that will not persist.
        throw new Error("Modules are not available yet.")
      }
      setSaving(true)
      try {
        const part = await createPart(params.id, trimmed)
        setParts([...parts(), part])
        closeDrawer()
        selectArtifact("part", part.id)
      } finally {
        setSaving(false)
      }
    })

  // Selecting an artifact is a navigation: the URL becomes the selection.
  const selectArtifact = (kind: "part" | "module", artifactId: string): void =>
    navigate(`/project/${params.id}/${kind}/${artifactId}`)

  return (
    <div class="hud-scene project-scene">
      {/* The 3D viewport. It owns the canvas outright: no signal reads
          anything it writes, and it publishes picks back as intent. */}
      <div class="hud-canvas project-canvas">
        <Viewport
          pickingPlane={planeField() !== null}
          selectedPlane={selectedPlaneId()}
          onPickPlane={acceptPlanePick}
          onScene={(scene) => { sceneRef = scene }}
        />
      </div>

      {/* TOP-LEFT: breadcrumb back to the dashboard */}
      <div class="hud-slot hud-top-left">
        <nav class="hud-panel hud-breadcrumb" aria-label="Breadcrumb">
          <button class="hud-crumb-link" onClick={() => navigate("/")}>Dashboard</button>
          <span class="hud-crumb-sep">›</span>
          {/* With a part selected, the project name becomes a link back to
              the project (deselect); otherwise it is the current crumb. */}
          <Show
            when={selectedPart()}
            fallback={<span class="hud-crumb-current">{project()?.name ?? "…"}</span>}
          >
            {(part) => (
              <>
                <button class="hud-crumb-link" onClick={() => navigate(`/project/${params.id}`)}>
                  {project()?.name ?? "…"}
                </button>
                <span class="hud-crumb-sep">›</span>
                <span class="hud-crumb-current">{part().name}</span>
              </>
            )}
          </Show>
        </nav>
      </div>

      {/* TOP CENTER: every feature, scanned from the registry as icons.
          Clicking one routes to /project/:id/features/:uuid, which opens
          its input HUD in front of the artifacts. */}
      {/* The feature toolbar only makes sense once a part is selected —
          features act on the selected artifact, so its route nests under
          the artifact. */}
      <Show when={selectedPart()}>
        <div class="hud-slot hud-top-center">
          <FeatureToolbar onActivate={activateCommand} />
        </div>
      </Show>

      {/* TOP-RIGHT: account / sign out */}
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
                    referrerpolicy="no-referrer"
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
              <button class="hud-button subtle" onClick={() => props.auth.signOut()}>Sign out</button>
            </div>
          )}
        </Show>
      </div>

      {/* LEFT COLUMN: artifacts (parts & modules), then the part outline */}
      <div class="hud-slot hud-left-column">
        <CollapsiblePanel
          id="artifacts"
          title="Artifacts"
          icon="package"
          class="hud-list-panel"
          actions={
            <SplitButton
              primary={{ label: "New part", onSelect: () => openDrawer("part") }}
              actions={[
                { label: "New part", onSelect: () => openDrawer("part") },
                { label: "New module", onSelect: () => openDrawer("module") },
              ]}
            />
          }
        >
          <ul class="hud-list">
            <For each={parts()} fallback={<li class="hud-empty">No parts yet.</li>}>
              {(part) => (
                <li
                  class="hud-item"
                  classList={{ active: selectedPart()?.id === part.id }}
                  onClick={() => selectArtifact("part", part.id)}
                >
                  <span class="hud-item-name">{part.name}</span>
                </li>
              )}
            </For>
          </ul>
        </CollapsiblePanel>

        {/* The outline is a property of a selected part — only then. */}
        <Show when={selectedPart()}>
          {(part) => (
            <CollapsiblePanel
              id="outline"
              title={`${part().name} — outline`}
              icon="list-tree"
              class="hud-outline-panel"
            >
              {/* The part's elements, in the order they were created —
                  the parametric history. Clicking one opens its designer.
                  The icon is the command's own metadata, so a new feature
                  appears here without a line of UI. */}
              <ul class="hud-list hud-outline-list">
                <For
                  each={elements()}
                  fallback={
                    <li class="hud-empty">
                      No elements yet — pick a feature above to begin.
                    </li>
                  }
                >
                  {(element) => (
                    <li
                      class="hud-item hud-outline-item"
                      classList={{ active: designing() === element.id }}
                      data-status={element.status}
                      onClick={() => setDesigning(element.id)}
                    >
                      <LucideIcon name={element.icon} size={14} />
                      <span class="hud-item-name">{element.label}</span>
                      <Show when={element.status === "editing"}>
                        <span class="hud-item-badge">editing</span>
                      </Show>
                      <button
                        class="hud-icon-button"
                        aria-label={`Remove ${element.label}`}
                        onClick={(event) => {
                          // The row itself selects; the button must not
                          // select the thing it is about to remove.
                          event.stopPropagation()
                          discardElement(element.id)
                        }}
                      >
                        <X size={12} />
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </CollapsiblePanel>
          )}
        </Show>
      </div>

      {/* The view cube is ALWAYS visible — a floating, freely draggable
          control (fixed position, user-dragged, persisted), independent of
          whether a part is selected. It rides above the HUD, so it is never
          covered by a panel. */}
      <ViewCube
        onPick={applyView}
        onNudge={nudgeView}
        onRoll={rollView}
        azimuth={cameraAngles().azimuth}
        elevation={cameraAngles().elevation}
        rollAngle={cameraAngles().roll}
      />

      {/* THE DESIGNER: the selected element's input HUD. Entirely
          derived from the command's metadata — the plane picker, the
          curve tools and the point lists below all come from
          draft/feature.ts, not from anything written here. */}
      <Show when={designed()}>
        {(element) => (
          <Show when={definitionOf(element().command)}>
            {(definition) => (
              <div class="hud-slot hud-designer">
                <CommandPanel
                  panel={element().panel}
                  definition={definition()}
                  onChange={(panel) =>
                    updateElement(selectedPart()!.id, element().id, (current) => ({
                      ...current,
                      panel,
                      // "built" the moment the machine says the input is
                      // complete, and back to "editing" if a later edit
                      // reopens a gap. Derived, never set by a click.
                      status: panel.canBuild ? "built" : "editing",
                    }))
                  }
                  onClose={() => setDesigning(null)}
                />
              </div>
            )}
          </Show>
        )}
      </Show>

      {/* The info panel and status bar are about the selected artifact —
          hidden until one is chosen. */}
      <Show when={selectedPart()}>
        {/* RIGHT: the info panel — a real HUD panel in its own right column. */}
        <div class="hud-slot hud-right-info">
          <CollapsiblePanel id="info" title="Info" icon="info" class="hud-info" defaultCollapsed>
            <p class="hud-empty">Selection & measurements — pending.</p>
          </CollapsiblePanel>
        </div>

        {/* BOTTOM: a status bar */}
        <div class="hud-slot hud-statusbar">
          <div class="hud-panel hud-status">
            <span>{project()?.name ?? "…"}</span>
            <span class="hud-status-sep">·</span>
            <span>{selectedPart()!.name}</span>
            <span class="hud-status-spacer" />
            <span class="hud-status-muted">ready</span>
          </div>
        </div>
      </Show>

      <Show when={error()}>
        {(message) => (
          <div class="hud-slot hud-bottom">
            <div class="hud-panel hud-toast">{message()}</div>
          </div>
        )}
      </Show>

      {/* New part / new module drawer */}
      <Drawer
        open={drawerKind() !== null}
        title={drawerKind() === "module" ? "New module" : "New part"}
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
