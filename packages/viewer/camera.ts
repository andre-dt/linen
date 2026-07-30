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

/** How long a view-cube transition takes. Long enough to read as motion
 *  — which is the point: it shows you HOW the model turned, so you keep
 *  your bearings — short enough not to feel like waiting. */
const VIEW_TRANSITION_SECONDS = 0.4

/** A quarter turn: how far one press of a corner arrow moves the azimuth.
 *  Four presses complete a revolution, and every stop is a corner of the
 *  cube. Elevation does not use this — it steps between the three levels
 *  a cube has corners at, which are not evenly spaced in angle. */
const NUDGE_STEP = Math.PI / 2

interface ViewTransition {
  readonly fromAzimuth: number
  readonly toAzimuth: number
  readonly fromElevation: number
  readonly toElevation: number
  elapsed: number
  /**
   * An ARC to sweep, instead of a pair of angles to interpolate.
   *
   * Present only for nudges. Interpolating azimuth and elevation
   * separately walks the sphere's parallels and meridians, so a diagonal
   * move bows away from the direct route — measurably, and visibly near
   * the poles where a degree of azimuth is almost no distance at all.
   * Rotating the start direction about a fixed axis keeps every
   * intermediate frame on one great circle, which is what a corner arrow
   * on a view cube should trace.
   */
  readonly arc?: {
    readonly from: Vector3
    readonly axis: Vector3
    readonly angle: number
  } | undefined
  /**
   * Roll, eased alongside the rest.
   *
   * A separate pair rather than part of the arc: roll is rotation about
   * the view direction, which the arc does not describe. Absent on
   * transitions that do not change it, so an ordinary view change costs
   * nothing extra.
   */
  readonly fromRoll?: number | undefined
  readonly toRoll?: number | undefined
}

/**
 * Rotates `vector` about `axis` (a unit vector) by `angle`, via
 * Rodrigues' formula. Shared by the nudge that plans an arc and the
 * frame loop that sweeps along it, so the two cannot drift apart.
 */
const rotateAbout = (vector: Vector3, axis: Vector3, angle: number): Vector3 => {
  const cosAngle = Math.cos(angle)
  const sinAngle = Math.sin(angle)
  const dot = axis[0] * vector[0] + axis[1] * vector[1] + axis[2] * vector[2]
  return [
    vector[0] * cosAngle +
      (axis[1] * vector[2] - axis[2] * vector[1]) * sinAngle +
      axis[0] * dot * (1 - cosAngle),
    vector[1] * cosAngle +
      (axis[2] * vector[0] - axis[0] * vector[2]) * sinAngle +
      axis[1] * dot * (1 - cosAngle),
    vector[2] * cosAngle +
      (axis[0] * vector[1] - axis[1] * vector[0]) * sinAngle +
      axis[2] * dot * (1 - cosAngle),
  ]
}

/** The unit view direction for a pair of angles. */
const directionOf = (azimuth: number, elevation: number): Vector3 => [
  Math.cos(elevation) * Math.cos(azimuth),
  Math.cos(elevation) * Math.sin(azimuth),
  Math.sin(elevation),
]

/**
 * The great circle joining two poses: the axis to turn about and how far.
 *
 * Returns null when the two are the same point, or exactly opposite — in
 * both cases the arc is undefined (no unique plane contains them), and
 * the caller falls back to interpolating the angles.
 */
const arcBetween = (
  fromAzimuth: number, fromElevation: number,
  toAzimuth: number, toElevation: number,
): { from: Vector3; axis: Vector3; angle: number } | undefined => {
  const from = directionOf(fromAzimuth, fromElevation)
  const to = directionOf(toAzimuth, toElevation)

  const axis: Vector3 = [
    from[1] * to[2] - from[2] * to[1],
    from[2] * to[0] - from[0] * to[2],
    from[0] * to[1] - from[1] * to[0],
  ]
  const length = Math.hypot(axis[0], axis[1], axis[2])
  // Degenerate: identical or antipodal. Not an error — a nudge clamped at
  // the pole legitimately asks to go nowhere.
  if (length < 1e-9) return undefined

  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2]
  return {
    from,
    axis: [axis[0] / length, axis[1] / length, axis[2] / length],
    // atan2 of the cross and dot magnitudes, rather than acos(dot): it
    // stays accurate for the small angles a clamped step produces, where
    // acos loses most of its precision.
    angle: Math.atan2(length, dot),
  }
}

/** Ease in and out. Linear interpolation reads as mechanical; starting
 *  and ending at rest is what makes the motion feel physical. */
const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

export interface OrbitCamera extends Camera {
  viewProjection(aspect: number): Matrix
}

export function createCamera(): OrbitCamera {
  let target: Vector3 = [0, 0, 0]
  let distance = 250
  let azimuth = Math.PI / 4
  let elevation = Math.PI / 6
  /**
   * ROLL: rotation about the view direction itself.
   *
   * Zero for every standard view and for orbiting — the camera keeps
   * world up on screen, which is what a CAD viewport should do. Only the
   * view cube's circular arrows change it, and they step in quarter
   * turns, so the model can be worked on sideways without the user
   * having to tilt their head.
   */
  let roll = 0
  // ORTHOGRAPHIC by default.
  //
  // A CAD viewport measures things. Under perspective two equal edges at
  // different depths are drawn at different lengths, so the picture
  // cannot be trusted for comparison — which is why every drafting view
  // is parallel. It also keeps the datum planes' labels at a constant
  // scale across the surface, instead of stretching toward the far edge.
  //
  // Perspective is available for the times a shape reads better with
  // depth cues; `setProjection` switches between them.
  let projection: Projection = {
    kind: "orthographic",
    height: 240,
    near: -100_000,
    far: 100_000,
  }
  /** Kept so a switch back to perspective restores the same framing. */
  let fieldOfView = Math.PI / 4

  /** An in-flight view transition, or null when the camera is at rest. */
  let transition: ViewTransition | null = null

  /**
   * The camera's up vector, world up turned by the current roll.
   *
   * Derived rather than stored: roll is one number, and keeping the
   * vector in sync with it by hand is the kind of duplicated state that
   * drifts. At zero roll this returns screen-up exactly, so the ordinary
   * case is unchanged.
   */
  const upVector = (): Vector3 => {
    const forward = directionOf(azimuth, elevation)
    // The up vector that stays perpendicular to the view direction at ANY
    // elevation — including past the poles, where its Z term (cos) goes
    // negative and turns the frame over so free tumble reads right. Built
    // for every elevation, not just when rolled, because at the pole a
    // fixed [0,0,1] would be PARALLEL to the view direction and collapse
    // lookAt.
    let worldUp: Vector3 = [
      -Math.sin(elevation) * Math.cos(azimuth),
      -Math.sin(elevation) * Math.sin(azimuth),
      Math.cos(elevation),
    ]
    // Exactly on a pole the view direction is ±Z and worldUp is the zero
    // vector; nudge to a defined screen-up so lookAt stays well-formed.
    // A continuous drag only lands here with measure zero, so this is a
    // guard, not a path the user feels.
    if (Math.hypot(worldUp[0], worldUp[1], worldUp[2]) < 1e-9) {
      worldUp = [-Math.cos(azimuth), -Math.sin(azimuth), 0]
    }
    if (roll === 0) return worldUp
    return rotateAbout(worldUp, forward, roll)
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
    // Exposed READ-ONLY, for controls that must mirror the camera's
    // orientation rather than drive it — the view cube turns with the
    // model, so it needs the angles, but it changes them only through
    // viewFrom/nudge/roll like anything else.
    get azimuth() { return azimuth },
    get elevation() { return elevation },
    // Named rollAngle, not roll: `roll` is already the METHOD that turns
    // the view. One name cannot be both an accessor and a function.
    get rollAngle() { return roll },
    get target() { return target },
    get up() { return upVector() },
    get projection() { return projection },

    orbit(deltaAzimuth, deltaElevation) {
      // A drag cancels any animation: the user has taken the wheel, and
      // fighting them for control of the camera is the worst outcome.
      transition = null
      azimuth += deltaAzimuth
      // FREE TUMBLE: elevation is NOT clamped at the poles. The derived
      // up vector (see upVector) is built from the same elevation, so it
      // stays perpendicular to the view direction as elevation carries on
      // past ±90° and the frame turns over cleanly instead of flipping.
      // Only the single exact pole (cos(elevation) === 0) is degenerate,
      // and a continuous drag crosses it with measure zero; upVector
      // nudges off it if a frame lands exactly there.
      elevation += deltaElevation
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

    dolly(delta, focal) {
      // Multiplicative: zooming feels linear to the user at every scale,
      // and distance can never cross zero and invert the view.
      const factor = Math.exp(delta * 0.001)

      // Half the VISIBLE WORLD HEIGHT at the target plane, before the zoom.
      // `focal` is measured in exactly this unit (half-heights from centre),
      // so the cursor's world offset from the target is simply focal × this.
      //   orthographic: the projection height IS the visible height.
      //   perspective:  the frustum half-height at the target is
      //                 distance · tan(fov/2).
      const halfHeightBefore =
        projection.kind === "orthographic"
          ? projection.height / 2
          : distance * Math.tan(fieldOfView / 2)

      distance = Math.max(0.01, distance * factor)
      // Under orthographic, distance does not affect apparent size — the
      // VISIBLE HEIGHT is what zoom means. Scaling it by the same factor
      // makes the wheel feel identical in both modes.
      if (projection.kind === "orthographic") {
        projection = {
          ...projection,
          height: Math.max(0.01, projection.height * factor),
        }
      }

      // Zoom TOWARD the cursor: the world point under it must not move. Its
      // offset from the target is focal × halfHeight; the half-height shrank
      // by the zoom, so the offset would shrink with it unless we shift the
      // target by the exact difference. No fudge factor — this is the real
      // pixel→world scale, so the point stays locked under the cursor.
      if (!focal) return
      const halfHeightAfter =
        projection.kind === "orthographic"
          ? projection.height / 2
          : distance * Math.tan(fieldOfView / 2)
      const scale = halfHeightBefore - halfHeightAfter
      const right: Vector3 = [-Math.sin(azimuth), Math.cos(azimuth), 0]
      const up: Vector3 = [
        -Math.sin(elevation) * Math.cos(azimuth),
        -Math.sin(elevation) * Math.sin(azimuth),
        Math.cos(elevation),
      ]
      target = [
        target[0] + (right[0] * focal[0] + up[0] * focal[1]) * scale,
        target[1] + (right[1] * focal[0] + up[1] * focal[1]) * scale,
        target[2] + (right[2] * focal[0] + up[2] * focal[1]) * scale,
      ]
    },

    setProjection(kind) {
      if (kind === projection.kind) return
      if (kind === "perspective") {
        projection = { kind: "perspective", fieldOfView, near: 0.1, far: 100_000 }
      } else {
        // Match the height currently visible at the target's depth, so
        // the switch does not jump the zoom level.
        projection = {
          kind: "orthographic",
          height: 2 * distance * Math.tan(fieldOfView / 2),
          // Symmetric and generous: an orthographic box has no
          // perspective divide, so a near plane behind the camera is
          // legitimate and stops geometry between camera and target
          // being clipped away.
          near: -100_000,
          far: 100_000,
        }
      }
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

    viewFrom(direction, immediate = false) {
      // A named view means the named ORIENTATION: "Top" with a quarter
      // roll still on is not Top. Cleared here so the face cells always
      // land somewhere recognisable, however the camera got turned.
      roll = 0
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
        // FRONT-right, not back-right. Front looks along -Y, so the
        // front corners are the ones with a negative Y — azimuth in the
        // lower half circle. At +PI/4 the camera sat at (+X, +Y), which
        // is the BACK-right corner: the app opened looking at the model
        // from behind, and every face-on label on the view cube read
        // inverted because it was being seen from the far side.
        isometric: [-Math.PI / 4, ISOMETRIC_ELEVATION],
        // The four corners, so a view cube's corner cells each land
        // somewhere distinct instead of all snapping to one.
        // The four named corners, each actually AT the corner it names.
        // These were a quarter turn out: "front-right" pointed at the
        // back-right corner and "back-right" at the front-right one, so
        // two of the four were plain wrong and the other two swapped.
        "isometric-front-right": [-Math.PI / 4, ISOMETRIC_ELEVATION],
        "isometric-front-left": [(-3 * Math.PI) / 4, ISOMETRIC_ELEVATION],
        "isometric-back-left": [(3 * Math.PI) / 4, ISOMETRIC_ELEVATION],
        "isometric-back-right": [Math.PI / 4, ISOMETRIC_ELEVATION],
      }
      const [targetAzimuth, targetElevation] = angles[direction]

      if (immediate) {
        transition = null
        azimuth = targetAzimuth
        elevation = targetElevation
        return
      }

      // Take the SHORT way round.
      //
      // Azimuth is an angle on a circle, so 350° -> 10° is twenty
      // degrees, not three hundred and forty. Interpolating the raw
      // numbers would spin the model most of the way round the wrong
      // direction — the single thing that makes a view transition feel
      // broken rather than smooth.
      let delta = targetAzimuth - azimuth
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2

      transition = {
        fromAzimuth: azimuth,
        toAzimuth: azimuth + delta,
        fromElevation: elevation,
        toElevation: targetElevation,
        elapsed: 0,
      }
    },

    lookFrom(direction, immediate = false) {
      // An ARBITRARY direction, for the view cube: its twenty-six
      // regions are more poses than the named-view table holds, and
      // enumerating them there would duplicate geometry the caller
      // already has as a vector.
      const length = Math.hypot(direction[0], direction[1], direction[2])
      // A zero vector names no direction. Ignored rather than throwing:
      // it can only come from a malformed caller, and dropping a camera
      // move is a far better failure than tearing down the viewport.
      if (length < 1e-9) return

      const x = direction[0] / length
      const y = direction[1] / length
      const z = direction[2] / length

      // A named view means the named ORIENTATION, so this clears roll
      // for the same reason viewFrom does.
      roll = 0

      const targetElevation = Math.max(
        -POLE_LIMIT,
        Math.min(POLE_LIMIT, Math.asin(Math.max(-1, Math.min(1, z)))),
      )
      // Straight up or down (Top/Bottom) leaves the azimuth undetermined
      // by the direction alone — every azimuth points at the same place.
      // After a free tumble the current azimuth is arbitrary, so keeping
      // it would land the face rotated. Snap to the CANONICAL azimuth for
      // the pole instead (the same one viewFrom's top/bottom use), so the
      // face always arrives square and upright.
      const targetAzimuth =
        Math.hypot(x, y) < 1e-9 ? -Math.PI / 2 : Math.atan2(y, x)

      if (immediate) {
        transition = null
        azimuth = targetAzimuth
        elevation = targetElevation
        return
      }

      // Free tumble can wind elevation past a full turn; bring the START
      // into the canonical range so the transition interpolates the short
      // way on BOTH angles, not the many turns a wound-up value implies.
      azimuth = ((azimuth % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
      elevation = Math.atan2(
        Math.sin(elevation),
        Math.cos(elevation),
      )

      // Short way round, as viewFrom does: interpolating raw angles
      // across the seam would spin the model most of the way the wrong
      // direction.
      let delta = targetAzimuth - azimuth
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2

      transition = {
        fromAzimuth: azimuth,
        toAzimuth: azimuth + delta,
        fromElevation: elevation,
        toElevation: targetElevation,
        elapsed: 0,
        arc: arcBetween(azimuth, elevation, azimuth + delta, targetElevation),
        fromRoll: roll,
        toRoll: 0,
      }
    },

    advance(deltaSeconds) {
      if (!transition) return false

      transition.elapsed += deltaSeconds
      const t = Math.min(1, transition.elapsed / VIEW_TRANSITION_SECONDS)
      const eased = easeInOutCubic(t)

      if (transition.arc) {
        // Along the great circle: rotate the start direction by the eased
        // fraction of the arc, then read it back out as angles. Keeps
        // every frame on the same plane, which interpolating the two
        // angles separately does not.
        const swept = rotateAbout(
          transition.arc.from,
          transition.arc.axis,
          transition.arc.angle * eased,
        )
        elevation = Math.max(
          -POLE_LIMIT,
          Math.min(POLE_LIMIT, Math.asin(Math.max(-1, Math.min(1, swept[2])))),
        )
        // Unwrapped against the previous frame, not taken raw: atan2's
        // seam at +/-pi would otherwise make the camera jump a full turn
        // mid-sweep.
        const raw = Math.atan2(swept[1], swept[0])
        let step = raw - azimuth
        while (step > Math.PI) step -= Math.PI * 2
        while (step < -Math.PI) step += Math.PI * 2
        azimuth += step
      } else {
        azimuth =
          transition.fromAzimuth + (transition.toAzimuth - transition.fromAzimuth) * eased
        elevation =
          transition.fromElevation + (transition.toElevation - transition.fromElevation) * eased
      }

      if (transition.toRoll !== undefined && transition.fromRoll !== undefined) {
        roll =
          transition.fromRoll +
          (transition.toRoll - transition.fromRoll) * eased
      }

      if (t >= 1) {
        // Wrapped only once the sweep is over. Wrapping mid-flight would
        // jump the interpolation across the seam at a full turn.
        roll = ((roll % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        transition = null
        return false
      }
      // Still moving: the caller must keep drawing.
      return true
    },

    viewProjection(aspect) {
      const view = lookAt(position(), target, upVector())
      const projectionMatrix =
        projection.kind === "perspective"
          ? perspective(projection.fieldOfView, aspect, projection.near, projection.far)
          : orthographic(projection.height, aspect, projection.near, projection.far)
      return matrixMultiply(projectionMatrix, view)
    },
  }
}
