// =====================================================================
// packages/viewer/math.ts
//
// Column-major 4x4 matrices, matching what WebGL and WebGPU expect.
// Right-handed with Z up, the same convention as the kernel — mixing
// handedness between the two would mirror every model silently.
// =====================================================================

export type Matrix = Float32Array

export function identity(): Matrix {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}

export function matrixMultiply(a: Matrix, b: Matrix): Matrix {
  const out = new Float32Array(16)
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row]! * b[column * 4 + k]!
      }
      out[column * 4 + row] = sum
    }
  }
  return out
}

export function perspective(
  fieldOfView: number,
  aspect: number,
  near: number,
  far: number,
): Matrix {
  const f = 1 / Math.tan(fieldOfView / 2)
  const out = new Float32Array(16)
  out[0] = f / aspect
  out[5] = f
  out[10] = (far + near) / (near - far)
  out[11] = -1
  out[14] = (2 * far * near) / (near - far)
  return out
}

export function orthographic(
  height: number,
  aspect: number,
  near: number,
  far: number,
): Matrix {
  const halfHeight = height / 2
  const halfWidth = halfHeight * aspect
  const out = new Float32Array(16)
  out[0] = 1 / halfWidth
  out[5] = 1 / halfHeight
  out[10] = -2 / (far - near)
  out[14] = -(far + near) / (far - near)
  out[15] = 1
  return out
}

export function lookAt(
  eye: readonly [number, number, number],
  target: readonly [number, number, number],
  up: readonly [number, number, number],
): Matrix {
  const forward = normalize(subtract(target, eye))
  const right = normalize(cross(forward, up))
  const trueUp = cross(right, forward)

  const out = new Float32Array(16)
  out[0] = right[0];   out[4] = right[1];   out[8]  = right[2]
  out[1] = trueUp[0];  out[5] = trueUp[1];  out[9]  = trueUp[2]
  out[2] = -forward[0]; out[6] = -forward[1]; out[10] = -forward[2]
  out[12] = -dot(right, eye)
  out[13] = -dot(trueUp, eye)
  out[14] = dot(forward, eye)
  out[15] = 1
  return out
}

type Vector = readonly [number, number, number]

export function subtract(a: Vector, b: Vector): Vector {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function add(a: Vector, b: Vector): Vector {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

export function scale(a: Vector, factor: number): Vector {
  return [a[0] * factor, a[1] * factor, a[2] * factor]
}

export function dot(a: Vector, b: Vector): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function cross(a: Vector, b: Vector): Vector {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

export function length(a: Vector): number {
  return Math.sqrt(dot(a, a))
}

export function normalize(a: Vector): Vector {
  const magnitude = length(a)
  // A zero vector has no direction; returning it unchanged beats
  // producing NaN that then propagates silently through the matrix.
  return magnitude < 1e-12 ? a : scale(a, 1 / magnitude)
}

/**
 * Full 4x4 inverse, by cofactor expansion.
 *
 * Needed for ray casting: the view-projection maps world to clip, so
 * unprojecting a cursor position requires going the other way. A general
 * inverse rather than the cheaper "transpose the rotation, negate the
 * translation" shortcut, because a PROJECTION matrix is not rigid — that
 * shortcut is only valid for view matrices and would be silently wrong
 * here.
 *
 * Returns null for a singular matrix instead of dividing by zero and
 * filling the result with Infinity, which would poison every coordinate
 * derived from it.
 */
export function invert(m: Matrix): Matrix | null {
  const s0 = m[0]! * m[5]! - m[4]! * m[1]!
  const s1 = m[0]! * m[6]! - m[4]! * m[2]!
  const s2 = m[0]! * m[7]! - m[4]! * m[3]!
  const s3 = m[1]! * m[6]! - m[5]! * m[2]!
  const s4 = m[1]! * m[7]! - m[5]! * m[3]!
  const s5 = m[2]! * m[7]! - m[6]! * m[3]!

  const c5 = m[10]! * m[15]! - m[14]! * m[11]!
  const c4 = m[9]! * m[15]! - m[13]! * m[11]!
  const c3 = m[9]! * m[14]! - m[13]! * m[10]!
  const c2 = m[8]! * m[15]! - m[12]! * m[11]!
  const c1 = m[8]! * m[14]! - m[12]! * m[10]!
  const c0 = m[8]! * m[13]! - m[12]! * m[9]!

  const determinant =
    s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0
  if (Math.abs(determinant) < 1e-20) return null
  const d = 1 / determinant

  return new Float32Array([
    (m[5]! * c5 - m[6]! * c4 + m[7]! * c3) * d,
    (-m[1]! * c5 + m[2]! * c4 - m[3]! * c3) * d,
    (m[13]! * s5 - m[14]! * s4 + m[15]! * s3) * d,
    (-m[9]! * s5 + m[10]! * s4 - m[11]! * s3) * d,

    (-m[4]! * c5 + m[6]! * c2 - m[7]! * c1) * d,
    (m[0]! * c5 - m[2]! * c2 + m[3]! * c1) * d,
    (-m[12]! * s5 + m[14]! * s2 - m[15]! * s1) * d,
    (m[8]! * s5 - m[10]! * s2 + m[11]! * s1) * d,

    (m[4]! * c4 - m[5]! * c2 + m[7]! * c0) * d,
    (-m[0]! * c4 + m[1]! * c2 - m[3]! * c0) * d,
    (m[12]! * s4 - m[13]! * s2 + m[15]! * s0) * d,
    (-m[8]! * s4 + m[9]! * s2 - m[11]! * s0) * d,

    (-m[4]! * c3 + m[5]! * c1 - m[6]! * c0) * d,
    (m[0]! * c3 - m[1]! * c1 + m[2]! * c0) * d,
    (-m[12]! * s3 + m[13]! * s1 - m[14]! * s0) * d,
    (m[8]! * s3 - m[9]! * s1 + m[10]! * s0) * d,
  ])
}
