// =====================================================================
// packages/viewer/cube-scene.test.ts
//
// Black-box tests at the view cube's REAL surface: you point the cube at
// an orientation (render), then click a pixel (pick), and check which
// region you get. This drives the exact projection + unproject + ray-cast
// the widget uses — at real screen pixels — so it covers the things that
// actually matter to a user:
//
//   - clicking the face / corner you are looking at,
//   - clicking THROUGH the gap around a face to the back plate behind it,
//   - a part on the FAR side not being clickable (the ray passes through),
//   - clicking empty space hitting nothing,
//   - and that rotating the cube changes what is under the cursor.
//
// No GPU: the drawing engine is a no-op stub. Picking never touched the
// GPU anyway — it is pure math off the same matrix render() builds.
// =====================================================================

import { describe, it, expect, beforeEach } from "vitest"
import { createCubeSceneOnEngine, type CubeScene } from "./cube-scene"
import type { DrawEngine, MeshHandle, LabelHandle } from "./engine/engine"

// A drawing engine that draws nothing. The cube's picking is CPU-side, so
// a scene on this stub picks identically to one on a real GPU.
const stubEngine = (): DrawEngine => ({
  backend: "webgl2",
  createMesh: () => ({} as MeshHandle),
  createDynamicMesh: () => ({} as MeshHandle),
  updateMesh: () => {},
  destroyMesh: () => {},
  writeLabel: () => ({} as LabelHandle),
  destroyLabel: () => {},
  frame: () => {},
  resize: () => {},
  dispose: () => {},
})

// A square canvas of a known size; pick() reads width/height off it.
const SIZE = 200
const CENTRE = SIZE / 2
const fakeCanvas = () => ({ width: SIZE, height: SIZE }) as HTMLCanvasElement

// The kernel frame: X right, Y away at Front, Z up. An orientation is the
// (azimuth, elevation, roll) the model camera would be at when looking
// from a given direction — the same triple render() takes.
const STRAIGHT = 0
const looking = {
  atTop: [-Math.PI / 2, Math.PI / 2, 0] as const,
  atBottom: [-Math.PI / 2, -Math.PI / 2, 0] as const,
  atFront: [-Math.PI / 2, 0, 0] as const,
  atRight: [0, 0, 0] as const,
  atCorner: [Math.PI / 4, Math.atan(1 / Math.SQRT2), 0] as const, // +X+Y+Z
}

describe("view cube — clicking what you look at", () => {
  let cube: CubeScene
  beforeEach(() => {
    cube = createCubeSceneOnEngine(fakeCanvas(), stubEngine())
  })

  const centreLabelWhenLookingAt = (orientation: readonly [number, number, number]) => {
    cube.render(orientation[0], orientation[1], orientation[2])
    return cube.pick(CENTRE, CENTRE)?.label ?? null
  }

  it("clicks the face you are looking straight at", () => {
    expect(centreLabelWhenLookingAt(looking.atTop)).toBe("Top")
    expect(centreLabelWhenLookingAt(looking.atFront)).toBe("Front")
    expect(centreLabelWhenLookingAt(looking.atRight)).toBe("Right")
    expect(centreLabelWhenLookingAt(looking.atBottom)).toBe("Bottom")
  })

  it("clicks the corner disc you are facing", () => {
    const hit = (() => {
      cube.render(...looking.atCorner)
      return cube.pick(CENTRE, CENTRE)
    })()
    expect(hit?.kind).toBe("corner")
    expect(hit?.label).toBe("Top back right")
  })

  it("clicks nothing when the cursor is off the cube", () => {
    cube.render(...looking.atFront)
    // A corner of the 200px canvas is past the cube's silhouette.
    expect(cube.pick(1, 1)).toBeNull()
  })
})

describe("view cube — the hollow behaviour (cube-spec.md §4)", () => {
  let cube: CubeScene
  beforeEach(() => {
    cube = createCubeSceneOnEngine(fakeCanvas(), stubEngine())
    cube.render(...looking.atTop) // looking straight down at Top
  })

  it("returns the near FRONT plate at the centre, never the far one", () => {
    // Facing Top, the centre ray meets Top's front plate first and the
    // Bottom back plate far behind it. Nearest wins → Top, a "face".
    const hit = cube.pick(CENTRE, CENTRE)
    expect(hit?.label).toBe("Top")
    expect(hit?.kind).toBe("face")
  })

  it("punches THROUGH the gap around the face to the back plate behind", () => {
    // Away from centre — but still on the cube — the ray misses Top's
    // small front plate (there is a void gap around it) and carries on to
    // the Bottom face's large BACK plate, which faces up and is hittable.
    // Scan outward along +X in screen space until we leave the front plate.
    let punched: { kind: string; label: string } | null = null
    for (let px = CENTRE + 1; px < SIZE; px += 1) {
      const hit = cube.pick(px, CENTRE)
      if (hit && hit.kind === "back") { punched = hit; break }
      if (!hit) break // off the cube entirely
    }
    expect(punched, "a ray in the gap should reach a back plate").not.toBeNull()
    // It is the Bottom face's back plate seen through Top's gap.
    expect(punched!.label).toBe("Bottom")
  })

  it("does NOT click a face from behind — the far side is see-through", () => {
    // Everything the centre ray can hit while facing Top must be a part
    // whose front is toward us. In particular it is never Bottom's FRONT
    // plate (that faces away, on the far side) — only ever Bottom's BACK.
    for (let px = 0; px < SIZE; px += 4) {
      for (let py = 0; py < SIZE; py += 4) {
        const hit = cube.pick(px, py)
        if (!hit) continue
        // A far-side front plate would be "Bottom"/"face"; that must never
        // happen. Bottom may only appear as its back plate.
        expect(hit.kind === "face" && hit.label === "Bottom").toBe(false)
      }
    }
  })
})

describe("view cube — rotating changes what is under the cursor", () => {
  it("follows the orientation: the centre shows whichever face now faces you", () => {
    const cube = createCubeSceneOnEngine(fakeCanvas(), stubEngine())
    const centre = (o: readonly [number, number, number]) => {
      cube.render(o[0], o[1], o[2])
      return cube.pick(CENTRE, CENTRE)?.label ?? null
    }
    // Turn the cube from face to face; the centre pick tracks it.
    expect(centre(looking.atFront)).toBe("Front")
    expect(centre(looking.atRight)).toBe("Right")
    expect(centre(looking.atTop)).toBe("Top")
    // And a fractional turn between Front and Right lands on neither's
    // centre as a face — it should be a corner/edge region or empty, never
    // still "Front".
    const between = centre([-Math.PI / 4, 0, STRAIGHT])
    expect(between).not.toBe("Front")
  })
})
