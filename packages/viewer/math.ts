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
