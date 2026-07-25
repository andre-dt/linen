// =====================================================================
// apps/web/widgets/lucide-icon.tsx — render any lucide icon BY NAME.
//
// The web app stays dumb and extensible: a feature's metadata says which
// lucide icon it wants (e.g. "box", "pen-line"), and this component loads
// that icon module on demand. There is NO name→component map to maintain
// — adding a feature never touches the UI.
//
// Vite's import.meta.glob pre-registers every icon module as a lazy
// import, each its own chunk. Unlike a bare dynamic import(), this is
// statically analysable, so the modules are actually emitted in the
// build — without pulling the whole ~1750-icon barrel into one bundle.
// =====================================================================

import { createResource, Suspense, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"

type IconComponent = Component<{ size?: number; class?: string }>

// One lazy loader per icon module. Keys look like
// "/node_modules/lucide-solid/dist/esm/icons/box.js".
const ICON_MODULES = import.meta.glob<{ default: IconComponent }>(
  "/node_modules/lucide-solid/dist/esm/icons/*.js",
)

const cache = new Map<string, IconComponent>()

const load = async (name: string): Promise<IconComponent | null> => {
  const cached = cache.get(name)
  if (cached) return cached
  const key = `/node_modules/lucide-solid/dist/esm/icons/${name}.js`
  const loader = ICON_MODULES[key]
  if (!loader) return null // unknown icon name: render nothing rather than crash
  const module = await loader()
  cache.set(name, module.default)
  return module.default
}

export function LucideIcon(props: { name: string; size?: number; class?: string }) {
  const [icon] = createResource(() => props.name, load)
  const size = (): number => props.size ?? 18
  return (
    <Suspense fallback={<span class="lucide-fallback" style={{ width: `${size()}px` }} />}>
      {icon() && <Dynamic component={icon()!} size={size()} class={props.class ?? ""} />}
    </Suspense>
  )
}
