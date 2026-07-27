// =====================================================================
// packages/viewer/camera.ts
//
// Orbit camera. Position is derived from spherical coordinates around a
// target rather than stored directly, which keeps orbiting stable: a
// stored position accumulates drift after a few thousand mouse moves.
//
// Elevation is clamped just short of the poles. Reaching one makes the
// up vector parallel to the view direction, and the frame flips.
// =====================================================================

import type { Camera, Projection, StandardView } from "./index"
import type { BoundingBox, Vector3 } from "@linen/cad/kernel"
import { lookAt, perspective, orthographic, matrixMultiply, type Matrix } from "./math"

const POLE_LIMIT = Math.PI / 2 - 0.01

/** How much of the viewport HEIGHT a fitted model occupies. 60% leaves a
 *  comfortable margin for the HUD panels that float over the canvas,
 *  without pushing the model so far away it reads as small. */
const DEFAULT_COVERAGE = 0.6

/** atan(1 / sqrt(2)) — the elevation at which the three axes foreshorten
 *  equally, which is what "isometric" actually means. */
const ISOMETRIC_ELEVATION = Math.atan(1 / Math.SQRT2)

export interface OrbitCamera extends Camera {
  viewProjection(aspect: number): Matrix
}

export function createCamera(): OrbitCamera {
  let target: Vector3 = [0, 0, 0]
  let distance = 250
  let azimuth = Math.PI / 4
  let elevation = Math.PI / 6
  let projection: Projection = {
    kind: "perspective",
    fieldOfView: Math.PI / 4,
    near: 0.1,
    far: 100_000,
  }

  const position = (): Vector3 => {
    const horizontal = Math.cos(elevation) * distance
    return [
      target[0] + horizontal * Math.cos(azimuth),
      target[1] + horizontal * Math.sin(azimuth),
      target[2] + Math.sin(elevation) * distance,
    ]
  }

  return {
    get position() { return position() },
    get target() { return target },
    up: [0, 0, 1], // Z up, matching the kernel
    get projection() { return projection },

    orbit(deltaAzimuth, deltaElevation) {
      azimuth += deltaAzimuth
      elevation = Math.max(-POLE_LIMIT, Math.min(POLE_LIMIT, elevation + deltaElevation))
    },

    pan(deltaX, deltaY) {
      // Pan in screen space, scaled by distance so the model tracks the
      // cursor at any zoom level.
      const scaleFactor = distance * 0.001
      const right: Vector3 = [-Math.sin(azimuth), Math.cos(azimuth), 0]
      const up: Vector3 = [
        -Math.sin(elevation) * Math.cos(azimuth),
        -Math.sin(elevation) * Math.sin(azimuth),
        Math.cos(elevation),
      ]
      target = [
        target[0] - (right[0] * deltaX + up[0] * deltaY) * scaleFactor,
        target[1] - (right[1] * deltaX + up[1] * deltaY) * scaleFactor,
        target[2] - (right[2] * deltaX + up[2] * deltaY) * scaleFactor,
      ]
    },

    dolly(delta) {
      // Multiplicative: zooming feels linear to the user at every scale,
      // and distance can never cross zero and invert the view.
      distance = Math.max(0.01, distance * Math.exp(delta * 0.001))
    },

    fit(bounds, coverage = DEFAULT_COVERAGE) {
      if (!bounds) return
      target = [
        (bounds.minimum[0] + bounds.maximum[0]) / 2,
        (bounds.minimum[1] + bounds.maximum[1]) / 2,
        (bounds.minimum[2] + bounds.maximum[2]) / 2,
      ]
      // The DIAGONAL, not the longest edge.
      //
      // What the viewport shows is the bounds projected from wherever the
      // camera happens to be. Seen isometrically a cube presents its
      // diagonal, which is √3 times its edge — so fitting on the edge
      // overfills by that much, and 60% comes out at 73%. The diagonal is
      // the only measure that bounds the silhouette from EVERY angle,
      // which is what makes the framing hold while the user orbits.
      const width = bounds.maximum[0] - bounds.minimum[0]
      const depth = bounds.maximum[1] - bounds.minimum[1]
      const tall = bounds.maximum[2] - bounds.minimum[2]
      const span = Math.hypot(width, depth, tall)
      if (span <= 0) return

      // Frame the bounds to occupy `coverage` of the viewport HEIGHT.
      //
      // Derived from the field of view rather than guessed at with a
      // multiplier: the visible height at the target's depth is
      // 2 * distance * tan(fov / 2), and we want the span to be that
      // times `coverage`. Solving for distance gives the line below.
      //
      // The old fixed 1.8x had no relation to the fov, so the model
      // filled a different fraction of the screen whenever the fov
      // changed — and the framing could not be reasoned about at all.
      if (projection.kind === "perspective") {
        distance = Math.max(span / (2 * coverage * Math.tan(projection.fieldOfView / 2)), 1e-3)
      } else {
        // Orthographic has no distance-to-size relation: the visible
        // height IS the projection height, so that is what changes.
        projection = { ...projection, height: span / coverage }
      }
    },

    viewFrom(direction) {
      const angles: Record<StandardView, readonly [number, number]> = {
        front: [-Math.PI / 2, 0],
        back: [Math.PI / 2, 0],
        left: [Math.PI, 0],
        right: [0, 0],
        top: [-Math.PI / 2, POLE_LIMIT],
        bottom: [-Math.PI / 2, -POLE_LIMIT],
        // TRUE isometric: the elevation where all three axes foreshorten
        // equally is atan(1/√2) ≈ 35.26°, not the 30° an isometric GRID
        // uses. At 30° the three planes meet at visibly unequal angles.
        isometric: [Math.PI / 4, ISOMETRIC_ELEVATION],
        // The four corners, so a view cube's corner cells each land
        // somewhere distinct instead of all snapping to one.
        "isometric-front-right": [Math.PI / 4, ISOMETRIC_ELEVATION],
        "isometric-front-left": [(3 * Math.PI) / 4, ISOMETRIC_ELEVATION],
        "isometric-back-left": [(5 * Math.PI) / 4, ISOMETRIC_ELEVATION],
        "isometric-back-right": [(7 * Math.PI) / 4, ISOMETRIC_ELEVATION],
      }
      const [nextAzimuth, nextElevation] = angles[direction]
      azimuth = nextAzimuth
      elevation = nextElevation
    },

    viewProjection(aspect) {
      const view = lookAt(position(), target, [0, 0, 1])
      const projectionMatrix =
        projection.kind === "perspective"
          ? perspective(projection.fieldOfView, aspect, projection.near, projection.far)
          : orthographic(projection.height, aspect, projection.near, projection.far)
      return matrixMultiply(projectionMatrix, view)
    },
  }
}
