// =====================================================================
// packages/viewer/mesh.ts
//
// Reads the packed mesh layout defined in @linen/cad/kernel.
//
// Every view returned here points INTO the received buffer. Nothing is
// copied: these same bytes came off the socket and go straight into GPU
// buffers, which is the entire reason for choosing a packed layout over
// an array of objects.
//
//   header:     u32 vertexCount, u32 triangleCount, u32 faceGroupCount
//   positions:  f32 * 3 * vertexCount
//   normals:    f32 * 3 * vertexCount
//   indices:    u32 * 3 * triangleCount
//   faceGroups: (u32 faceId, u32 firstTriangle, u32 triangleCount) * n
//
// A note on alignment: the header is twelve bytes, so the float section
// that follows is four-byte aligned but not eight. That is fine for
// Float32Array and Uint32Array, which is why the layout uses f32 rather
// than f64 for vertex data — the kernel computes in double and narrows
// on the way out.
// =====================================================================

import type { BoundingBox, FaceGroup, FaceId } from "@linen/cad/kernel"

const HEADER_BYTES = 12
const FACE_GROUP_BYTES = 12

export interface DecodedMesh {
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly indices: Uint32Array
  readonly faceGroups: readonly FaceGroup[]
  readonly bounds: BoundingBox
}

export function decodeMesh(buffer: ArrayBuffer): DecodedMesh {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`mesh buffer too small: ${buffer.byteLength} bytes`)
  }

  const header = new Uint32Array(buffer, 0, 3)
  const vertexCount = header[0]!
  const triangleCount = header[1]!
  const faceGroupCount = header[2]!

  const positionBytes = vertexCount * 3 * 4
  const normalBytes = vertexCount * 3 * 4
  const indexBytes = triangleCount * 3 * 4
  const groupBytes = faceGroupCount * FACE_GROUP_BYTES
  const expected = HEADER_BYTES + positionBytes + normalBytes + indexBytes + groupBytes

  // Checked rather than trusted: a truncated frame would otherwise read
  // past the end of one section into the next and render garbage that
  // looks like a geometry bug.
  if (buffer.byteLength < expected) {
    throw new Error(
      `mesh buffer truncated: expected ${expected} bytes, received ${buffer.byteLength}`,
    )
  }

  let offset = HEADER_BYTES
  const positions = new Float32Array(buffer, offset, vertexCount * 3)
  offset += positionBytes

  const normals = new Float32Array(buffer, offset, vertexCount * 3)
  offset += normalBytes

  const indices = new Uint32Array(buffer, offset, triangleCount * 3)
  offset += indexBytes

  const groupData = new Uint32Array(buffer, offset, faceGroupCount * 3)
  const faceGroups: FaceGroup[] = []
  for (let index = 0; index < faceGroupCount; index++) {
    faceGroups.push({
      face: groupData[index * 3]! as FaceId,
      firstTriangle: groupData[index * 3 + 1]!,
      triangleCount: groupData[index * 3 + 2]!,
    })
  }

  return { positions, normals, indices, faceGroups, bounds: computeBounds(positions) }
}

/** The header alone, for deciding whether a frame is worth decoding. */
export function readMeshHeader(buffer: ArrayBuffer) {
  const header = new Uint32Array(buffer, 0, 3)
  return {
    vertexCount: header[0]!,
    triangleCount: header[1]!,
    faceGroupCount: header[2]!,
  }
}

/** Resolves a triangle index back to the face that produced it: the
 *  basis of picking. */
export function faceOfTriangle(groups: readonly FaceGroup[], triangle: number): FaceId | null {
  for (const group of groups) {
    if (
      triangle >= group.firstTriangle &&
      triangle < group.firstTriangle + group.triangleCount
    ) {
      return group.face
    }
  }
  return null
}

function computeBounds(positions: Float32Array): BoundingBox {
  if (positions.length === 0) {
    return { minimum: [0, 0, 0], maximum: [0, 0, 0] }
  }

  let minimumX = Infinity, minimumY = Infinity, minimumZ = Infinity
  let maximumX = -Infinity, maximumY = -Infinity, maximumZ = -Infinity

  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index]!
    const y = positions[index + 1]!
    const z = positions[index + 2]!
    if (x < minimumX) minimumX = x
    if (y < minimumY) minimumY = y
    if (z < minimumZ) minimumZ = z
    if (x > maximumX) maximumX = x
    if (y > maximumY) maximumY = y
    if (z > maximumZ) maximumZ = z
  }

  return {
    minimum: [minimumX, minimumY, minimumZ],
    maximum: [maximumX, maximumY, maximumZ],
  }
}

// =====================================================================
// SYNTHETIC GEOMETRY
// =====================================================================
// A box in the wire format, so the whole client — upload, camera,
// shading, resize — can be exercised before the kernel exists. It
// produces exactly what the server will, which means the code path
// under test is the real one.

export function syntheticBox(width = 100, depth = 100, height = 60): ArrayBuffer {
  const halfWidth = width / 2
  const halfDepth = depth / 2

  // Six faces, four vertices each: shared corners cannot be reused
  // because each face needs its own normal, and a shared vertex would
  // average them into a rounded look.
  const faces: readonly {
    readonly corners: readonly (readonly [number, number, number])[]
    readonly normal: readonly [number, number, number]
  }[] = [
    { normal: [0, 0, 1], corners: [[-halfWidth, -halfDepth, height], [halfWidth, -halfDepth, height], [halfWidth, halfDepth, height], [-halfWidth, halfDepth, height]] },
    { normal: [0, 0, -1], corners: [[-halfWidth, halfDepth, 0], [halfWidth, halfDepth, 0], [halfWidth, -halfDepth, 0], [-halfWidth, -halfDepth, 0]] },
    { normal: [0, -1, 0], corners: [[-halfWidth, -halfDepth, 0], [halfWidth, -halfDepth, 0], [halfWidth, -halfDepth, height], [-halfWidth, -halfDepth, height]] },
    { normal: [1, 0, 0], corners: [[halfWidth, -halfDepth, 0], [halfWidth, halfDepth, 0], [halfWidth, halfDepth, height], [halfWidth, -halfDepth, height]] },
    { normal: [0, 1, 0], corners: [[halfWidth, halfDepth, 0], [-halfWidth, halfDepth, 0], [-halfWidth, halfDepth, height], [halfWidth, halfDepth, height]] },
    { normal: [-1, 0, 0], corners: [[-halfWidth, halfDepth, 0], [-halfWidth, -halfDepth, 0], [-halfWidth, -halfDepth, height], [-halfWidth, halfDepth, height]] },
  ]

  const vertexCount = faces.length * 4
  const triangleCount = faces.length * 2
  const faceGroupCount = faces.length

  const buffer = new ArrayBuffer(
    HEADER_BYTES +
      vertexCount * 3 * 4 * 2 +
      triangleCount * 3 * 4 +
      faceGroupCount * FACE_GROUP_BYTES,
  )

  new Uint32Array(buffer, 0, 3).set([vertexCount, triangleCount, faceGroupCount])

  let offset = HEADER_BYTES
  const positions = new Float32Array(buffer, offset, vertexCount * 3)
  offset += vertexCount * 3 * 4
  const normals = new Float32Array(buffer, offset, vertexCount * 3)
  offset += vertexCount * 3 * 4
  const indices = new Uint32Array(buffer, offset, triangleCount * 3)
  offset += triangleCount * 3 * 4
  const groups = new Uint32Array(buffer, offset, faceGroupCount * 3)

  faces.forEach((face, faceIndex) => {
    const base = faceIndex * 4
    face.corners.forEach((corner, cornerIndex) => {
      const target = (base + cornerIndex) * 3
      positions[target] = corner[0]
      positions[target + 1] = corner[1]
      positions[target + 2] = corner[2]
      normals[target] = face.normal[0]
      normals[target + 1] = face.normal[1]
      normals[target + 2] = face.normal[2]
    })

    const triangle = faceIndex * 6
    indices[triangle] = base
    indices[triangle + 1] = base + 1
    indices[triangle + 2] = base + 2
    indices[triangle + 3] = base
    indices[triangle + 4] = base + 2
    indices[triangle + 5] = base + 3

    // Face ids start at one: zero reads as "no face" when picking.
    groups[faceIndex * 3] = faceIndex + 1
    groups[faceIndex * 3 + 1] = faceIndex * 2
    groups[faceIndex * 3 + 2] = 2
  })

  return buffer
}
