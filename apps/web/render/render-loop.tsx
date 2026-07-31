// =====================================================================
// apps/web/render/render-loop.tsx — THE single animation-frame loop.
//
// One requestAnimationFrame for the whole 3D world. Anything that needs
// to run per frame — the model scene's draw, the view cube's draw —
// SUBSCRIBES a tick here instead of opening its own loop. The loop runs
// only while something is subscribed: the first subscriber starts it, the
// last to leave stops it (the same shape as ArrowProvider's measurement
// loop in the reference project).
//
// WHY ONE LOOP
// ------------
// Three separate loops used to drive the world: the viewport's draw, a
// poller that copied the camera's angles into a signal, and the cube's
// draw. They could not agree on ordering — the cube read the camera a
// frame behind the poll behind the draw. Collapsed into one ordered tick,
// a subscriber added later reads exactly the state an earlier subscriber
// just wrote, so the cube can never lag the camera.
//
// deltaSeconds is measured once and handed to every subscriber, so view
// transitions advance by real elapsed time rather than assuming 60fps.
// =====================================================================

import {
  createContext, useContext, onCleanup, type JSX,
} from "solid-js"

/** A per-frame callback. `deltaSeconds` is the real time since the last
 *  tick, so animation is frame-rate independent. */
export type RenderTick = (deltaSeconds: number) => void

interface RenderLoopValue {
  /** Register a per-frame tick. Returns an unsubscribe function; calling
   *  it (or the caller unmounting, if it subscribes from a component) stops
   *  that tick and — if it was the last — the loop itself. */
  subscribe: (tick: RenderTick) => () => void
}

const RenderLoopContext = createContext<RenderLoopValue>()

/**
 * Subscribes a per-frame tick for the lifetime of the calling component.
 * Registers on call and unsubscribes on the component's onCleanup, so
 * mounting a behaviour turns its frame work on and unmounting turns it
 * off — no handle to release by hand.
 */
export const useRenderTick = (tick: RenderTick): void => {
  const value = useContext(RenderLoopContext)
  if (!value) {
    throw new Error("useRenderTick must be used inside <RenderLoop>")
  }
  onCleanup(value.subscribe(tick))
}

/** The lower-level handle, for callers that must subscribe/unsubscribe
 *  imperatively (outside a component's lifecycle). Prefer useRenderTick. */
export const useRenderLoop = (): RenderLoopValue => {
  const value = useContext(RenderLoopContext)
  if (!value) {
    throw new Error("useRenderLoop must be used inside <RenderLoop>")
  }
  return value
}

export function RenderLoop(props: { children: JSX.Element }) {
  const ticks = new Set<RenderTick>()
  let frame: number | undefined
  // undefined until the first frame, so the first deltaSeconds is 0 rather
  // than the whole time since page load.
  let last: number | undefined

  const step = (now: number): void => {
    const deltaSeconds = last === undefined ? 0 : (now - last) / 1000
    last = now
    // Iterate a snapshot: a tick may unsubscribe (or subscribe) mid-frame,
    // and mutating the Set while iterating it would skip or double-run one.
    for (const tick of [...ticks]) tick(deltaSeconds)
    frame = requestAnimationFrame(step)
  }

  const start = (): void => {
    if (frame === undefined) {
      last = undefined
      frame = requestAnimationFrame(step)
    }
  }

  const stop = (): void => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      frame = undefined
    }
  }

  const value: RenderLoopValue = {
    subscribe: (tick) => {
      ticks.add(tick)
      start()
      return () => {
        ticks.delete(tick)
        if (ticks.size === 0) stop()
      }
    },
  }

  onCleanup(stop)

  return (
    <RenderLoopContext.Provider value={value}>
      {props.children}
    </RenderLoopContext.Provider>
  )
}
