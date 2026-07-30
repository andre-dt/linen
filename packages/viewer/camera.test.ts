// =====================================================================
// packages/viewer/camera.test.ts
//
// Black-box tests for the orbit camera. Drive it the way the app does —
// orbit(), lookFrom(), advance() — and assert only what it exposes:
// where it looks and which way is up. No internals.
// =====================================================================

import { describe, it, expect } from "vitest"
import { createCamera } from "./camera"
import type { Vector3 } from "@linen/cad/kernel"

type Camera = ReturnType<typeof createCamera>

/** The unit direction the camera looks along (from eye toward target). */
const gaze = (camera: Camera): Vector3 => {
  const d: Vector3 = [
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  ]
  const l = Math.hypot(d[0], d[1], d[2])
  return [d[0] / l, d[1] / l, d[2] / l]
}

/** Run any in-flight snap to completion. Returns every frame's up vector,
 *  so a test can watch the whole animation, not just its ends. */
const playSnap = (camera: Camera): Vector3[] => {
  const ups: Vector3[] = []
  while (camera.advance(1 / 60)) ups.push([...camera.up] as Vector3)
  return ups
}

describe("camera — free tumble", () => {
  it("keeps orbiting past the poles instead of stopping short", () => {
    const camera = createCamera()
    // Tumble straight up, well past vertical. A turntable would jam near
    // 90°; this keeps going, so the view ends up looking from the far side.
    for (let i = 0; i < 100; i += 1) camera.orbit(0, 0.05)
    expect(Math.abs(camera.elevation)).toBeGreaterThan(Math.PI / 2)
  })

  it("never loses a sensible up vector, even right over a pole", () => {
    const camera = createCamera()
    for (let i = 0; i < 200; i += 1) {
      camera.orbit(0, Math.PI / 37) // steps land on a pole too
      expect(Math.hypot(...camera.up)).toBeCloseTo(1, 3)
    }
  })
})

describe("camera — clicking a face snaps it square and upright", () => {
  it("lands each face looking straight at it", () => {
    const faces: [Vector3, Vector3][] = [
      [[0, 0, 1], [0, 0, -1]],   // Top: look down
      [[0, 0, -1], [0, 0, 1]],   // Bottom: look up
      [[1, 0, 0], [-1, 0, 0]],   // Right
      [[0, 1, 0], [0, -1, 0]],   // Back
    ]
    for (const [from, expectedGaze] of faces) {
      const camera = createCamera()
      camera.orbit(1.3, 3.7) // arbitrary tumble first
      camera.lookFrom(from, true)
      const g = gaze(camera)
      expect(g[0]).toBeCloseTo(expectedGaze[0], 5)
      expect(g[1]).toBeCloseTo(expectedGaze[1], 5)
      expect(g[2]).toBeCloseTo(expectedGaze[2], 5)
    }
  })

  it("lands Top and Bottom the same way up (+Y), not upside-down", () => {
    const top = createCamera()
    top.orbit(0.9, 2.1)
    top.lookFrom([0, 0, 1], true)
    expect(top.up[1]).toBeCloseTo(1, 4)

    const bottom = createCamera()
    bottom.orbit(0.9, 2.1)
    bottom.lookFrom([0, 0, -1], true)
    expect(bottom.up[1]).toBeCloseTo(1, 4)
  })

  it("keeps world up on a side view", () => {
    const camera = createCamera()
    camera.orbit(2.0, 1.7)
    camera.lookFrom([1, 0, 0], true)
    expect(camera.up[2]).toBeCloseTo(1, 4) // +Z stays up
  })
})

describe("camera — the snap animates smoothly", () => {
  it("does not jump on the first frame", () => {
    const camera = createCamera()
    camera.orbit(0.6, 2.4) // tumbled, possibly upside-down
    const before = [...camera.up] as Vector3

    camera.lookFrom([0, 0, 1]) // animated
    camera.advance(1 / 60)     // one frame in

    // A jump would flip the up vector on frame 1; a smooth ease barely
    // moves it.
    const moved = Math.hypot(
      camera.up[0] - before[0],
      camera.up[1] - before[1],
      camera.up[2] - before[2],
    )
    expect(moved).toBeLessThan(0.2)
  })

  it("crosses the pole without a sudden bump", () => {
    const camera = createCamera()
    camera.orbit(0.4, 1.2)
    camera.lookFrom([0, 0, 1]) // path runs up and over the pole
    const ups = playSnap(camera)
    expect(ups.length).toBeGreaterThan(5)

    // The up vector speeds up over the pole and slows again — a smooth
    // hump. A bump would be one step far bigger than its neighbours; assert
    // no such spike.
    const steps = ups.slice(1).map((u, i) =>
      Math.hypot(u[0] - ups[i]![0], u[1] - ups[i]![1], u[2] - ups[i]![2]),
    )
    for (let i = 1; i < steps.length - 1; i += 1) {
      const neighbours = (steps[i - 1]! + steps[i + 1]!) / 2
      expect(steps[i]! / (neighbours + 1e-3)).toBeLessThan(1.5)
    }
  })

  it("ends exactly on the face and comes to rest", () => {
    const camera = createCamera()
    camera.orbit(1.1, 0.9)
    camera.lookFrom([0, 0, 1])
    playSnap(camera)
    expect(camera.advance(1 / 60)).toBe(false) // settled
    expect(gaze(camera)[2]).toBeCloseTo(-1, 4)  // dead-on Top
    expect(camera.up[1]).toBeCloseTo(1, 4)      // upright
  })
})
