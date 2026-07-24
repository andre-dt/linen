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

    fit(bounds) {
      if (!bounds) return
      target = [
        (bounds.minimum[0] + bounds.maximum[0]) / 2,
        (bounds.minimum[1] + bounds.maximum[1]) / 2,
        (bounds.minimum[2] + bounds.maximum[2]) / 2,
      ]
      const span = Math.max(
        bounds.maximum[0] - bounds.minimum[0],
        bounds.maximum[1] - bounds.minimum[1],
        bounds.maximum[2] - bounds.minimum[2],
      )
      // A little margin, so the model does not touch the viewport edge.
      distance = Math.max(span * 1.8, 1)
    },

    viewFrom(direction) {
      const angles: Record<StandardView, readonly [number, number]> = {
        front: [-Math.PI / 2, 0],
        back: [Math.PI / 2, 0],
        left: [Math.PI, 0],
        right: [0, 0],
        top: [-Math.PI / 2, POLE_LIMIT],
        bottom: [-Math.PI / 2, -POLE_LIMIT],
        isometric: [Math.PI / 4, Math.PI / 6],
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
