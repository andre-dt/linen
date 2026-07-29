// =====================================================================
// packages/viewer/cube-scene.ts — DRAWING THE VIEW CUBE.
//
// A self-contained WebGL2 renderer for the chamfered cube in cube.ts. It
// owns its own canvas and context, separate from the main viewport's:
// the two share no state and never draw into each other.
//
// WHY A SECOND CONTEXT
// --------------------
// The alternative was drawing the cube as an overlay inside the main
// scene, which sounds cheaper and is not. The cube needs its own
// projection (a fixed, tiny orthographic box), its own depth range, and
// must be immune to the model's fit/dolly — so it would need the main
// pass torn down and re-set-up around it every frame. A second context
// is one allocation at startup and nothing per frame.
//
// The cube is small and static, so this uploads its geometry once and
// redraws with a single uniform change per frame.
// =====================================================================

import {
  buildCube, pickCube,
  PANEL_HALF, PANEL_CORNER_RADIUS, CORNER_DISTANCE,
  type CubeRegion,
} from "./cube"
import {
  createCubeFaceTexture, uploadCubeFaceTexture, disposeCubeFaceTexture,
  type CubeFaceTexture,
} from "./cube-face-texture"
import { identity, matrixMultiply, orthographic, lookAt, invert, type Matrix } from "./math"
import type { Vector3 } from "@linen/cad/kernel"

/** Half-extent of the orthographic box the cube is drawn into.
 *
 *  Sized to the assembled cube's silhouette: the widest parts are the
 *  corner discs, whose centres sit at CORNER_DISTANCE along a body
 *  diagonal, plus their own radius. A little headroom past that keeps the
 *  control off the canvas edge. */
const VIEW_EXTENT = CORNER_DISTANCE + 0.35

/** The half-extent, in cube units, that a panel's label texture spans
 *  (cube-spec.md §5). Set to the panel's FULL extent so the whole word
 *  fits inside the panel; the DOM element's own CSS controls how large the
 *  glyphs sit within that texture. */
const LABEL_HALF_SPAN = PANEL_HALF + PANEL_CORNER_RADIUS

const VERTEX_SHADER = `#version 300 es
in vec3 position;
in vec2 uv;
uniform mat4 viewProjection;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = viewProjection * vec4(position, 1.0);
}
`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 tint;
uniform float highlighted;
uniform float labelled;
uniform sampler2D label;
out vec4 fragment;
void main() {
  // FLAT. No directional term at all.
  //
  // This is a CAD orientation readout, not a rendered object: a moving
  // highlight makes the same face look like different materials as the
  // model turns, and the point of the control is that a face's
  // appearance means one thing only. Faces, bevels and corners each get
  // one constant colour, and the form reads from the three tiers of
  // tint rather than from a light.
  vec3 shade = tint;
  shade = mix(shade, vec3(0.42, 0.62, 0.95), highlighted * 0.65);

  // Outside the label's patch of UV space there is no text, only the
  // facet's own colour. Without this the clamped edge texels smear the
  // outermost glyph pixels across the rest of the face.
  if (labelled > 0.5 &&
      vUv.x >= 0.0 && vUv.x <= 1.0 && vUv.y >= 0.0 && vUv.y <= 1.0) {
    // The texture is white-on-transparent, so its alpha is the glyph
    // coverage; the colour comes from here rather than the texture,
    // which lets one texture serve both the idle and lit states.
    float coverage = texture(label, vUv).a;
    shade = mix(shade, vec3(0.82, 0.87, 0.96), coverage);
  }

  fragment = vec4(shade, 1.0);
}
`

export interface CubeScene {
  /** Redraws. Called from the host's animation frame. */
  render(azimuth: number, elevation: number, roll: number): void
  /** What is under the cursor, in canvas pixels, or null. */
  pick(x: number, y: number): CubeRegion | null
  /** Lit while the pointer is over it. Set from `pick`. */
  hovered: CubeRegion | null
  resize(size: number, devicePixelRatio: number): void
  dispose(): void
}

/**
 * The BODY colour: one tone for the whole solid.
 *
 * The cube is built up in three passes, and this is the first — the
 * chamfered solid in a single flat tone, before anything is stamped on
 * it. Keyed to the HUD panel material (#101c34) a step brighter, so the
 * cube reads as a solid in front of the model rather than as another
 * panel, and no brighter than that: it is an instrument beside the
 * model, not the subject of the screen.
 *
 * Two failures bracket this value. At roughly the canvas's own darkness
 * the cube was a smudge; at full saturation it read as a bright toy
 * against a muted CAD interface.
 */
const BODY: Vector3 = [0.185, 0.240, 0.370]

/**
 * Colour per part (cube-spec.md §5).
 *
 * Panels are one uniform BODY tone; the DOM label alone distinguishes a
 * face. The corner discs are a touch lighter so the eight corner targets
 * read as their own controls. No tint STEPS across a single surface exist
 * anymore — every part is its own detached mesh — so there are no seams to
 * show.
 */
const FACE_COLOR: Vector3 = BODY
const CORNER_COLOR: Vector3 = [0.290, 0.360, 0.520]
// The large plain BACK plate: grayer/darker than the front, so the far
// side reads as a backdrop rather than another front panel (cube-spec.md
// §5).
const BACK_COLOR: Vector3 = [0.145, 0.180, 0.265]

interface Batch {
  readonly region: CubeRegion
  readonly offset: number
  readonly count: number
  readonly label: CubeFaceTexture | null
}

export const createCubeScene = (canvas: HTMLCanvasElement): CubeScene => {
  const gl = canvas.getContext("webgl2", {
    antialias: true,
    depth: true,
    alpha: true,
    premultipliedAlpha: false,
  })
  if (!gl) throw new Error("the view cube needs WebGL2")

  // Opt this canvas into HTML-in-Canvas: its child elements (the face
  // labels created below) are laid out and become readable by
  // `texElementImage2D`. Set imperatively because the canvas is created
  // by the host widget, not here — see cube-face-texture.ts.
  canvas.setAttribute("layoutsubtree", "")

  const program = buildProgram(gl)
  const regions = buildCube()

  // --- geometry, uploaded once ------------------------------------------
  // One position/uv buffer for all parts, drawn as one range per part.
  // The parts never change, so this is uploaded once.
  const positions: number[] = []
  const uvs: number[] = []
  const batches: Batch[] = []

  for (const region of regions) {
    const offset = positions.length / 3
    const count = region.positions.length / 3

    // Only face panels carry a DOM label. The corner discs have none, so
    // they need no texture and no meaningful UVs.
    const labelTexture =
      region.kind === "face"
        ? createCubeFaceTexture(gl, canvas, region.label)
        : null

    for (let index = 0; index < region.positions.length; index += 3) {
      positions.push(
        region.positions[index]!,
        region.positions[index + 1]!,
        region.positions[index + 2]!,
      )
    }

    if (region.kind === "face") {
      // The panel is a flat rounded square in a known face plane. Map each
      // vertex onto that plane's two in-plane axes (u, v) and into label
      // space [0, 1] over ±LABEL_HALF_SPAN. The label's up is chosen so
      // every face reads upright the way a view cube expects: on the
      // vertical faces the world Z axis is up; on the horizontal Top and
      // Bottom, where Z is the normal, the world Y axis stands in.
      const normal = region.normal
      const upWorld: Vector3 =
        Math.abs(normal[2]) > 0.5 ? [0, 1, 0] : [0, 0, 1]
      // right = up x normal, so (right, up) is a proper in-plane frame.
      const right: Vector3 = [
        upWorld[1] * normal[2] - upWorld[2] * normal[1],
        upWorld[2] * normal[0] - upWorld[0] * normal[2],
        upWorld[0] * normal[1] - upWorld[1] * normal[0],
      ]
      const rightLength = Math.hypot(right[0], right[1], right[2]) || 1
      const unitRight: Vector3 = [
        right[0] / rightLength, right[1] / rightLength, right[2] / rightLength,
      ]
      const up = upWorld
      for (let index = 0; index < region.positions.length; index += 3) {
        const x = region.positions[index]!
        const y = region.positions[index + 1]!
        const z = region.positions[index + 2]!
        const u =
          (x * unitRight[0] + y * unitRight[1] + z * unitRight[2]) /
            (2 * LABEL_HALF_SPAN) + 0.5
        const v =
          (x * up[0] + y * up[1] + z * up[2]) /
            (2 * LABEL_HALF_SPAN) + 0.5
        // V flipped: texture space grows downward.
        uvs.push(u, 1 - v)
      }
    } else {
      for (let index = 0; index < count; index += 1) uvs.push(0, 0)
    }

    batches.push({
      region,
      offset,
      count,
      label: labelTexture,
    })
  }

  const vertexArray = gl.createVertexArray()
  gl.bindVertexArray(vertexArray)

  const bind = (name: string, data: number[], size: number): WebGLBuffer => {
    const buffer = gl.createBuffer()
    if (!buffer) throw new Error(`could not create the ${name} buffer`)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW)
    const location = gl.getAttribLocation(program, name)
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0)
    return buffer
  }

  const positionBuffer = bind("position", positions, 3)
  const uvBuffer = bind("uv", uvs, 2)
  gl.bindVertexArray(null)

  // Populate the face-label textures AFTER a paint. Each face starts as a
  // transparent placeholder so the cube draws in its solid tints from the
  // first frame — the DOM upload cannot happen synchronously here because
  // `texElementImage2D` needs the label element to have been painted at
  // least once ("No cached paint record" otherwise). We retry on animation
  // frames until every face has taken, then stop; if the API is absent the
  // faces simply stay unlabelled and the cube is still fully usable.
  const pendingUploads = batches
    .map((batch) => batch.label)
    .filter((label): label is CubeFaceTexture => label !== null)
  const flushUploads = (): void => {
    for (let index = pendingUploads.length - 1; index >= 0; index -= 1) {
      if (uploadCubeFaceTexture(gl, pendingUploads[index]!)) {
        pendingUploads.splice(index, 1)
      }
    }
    if (pendingUploads.length > 0 && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flushUploads)
    }
  }
  if (pendingUploads.length > 0 && typeof requestAnimationFrame === "function") {
    requestAnimationFrame(flushUploads)
  }

  const uniform = (name: string) => gl.getUniformLocation(program, name)
  const uniforms = {
    viewProjection: uniform("viewProjection"),
    tint: uniform("tint"),
    highlighted: uniform("highlighted"),
    labelled: uniform("labelled"),
    label: uniform("label"),
  }

  /** Kept so `pick` can unproject with the same matrix that was drawn. */
  let lastViewProjection: Matrix = identity()
  let pixelSize = 1

  const state = {
    hovered: null as CubeRegion | null,
  }

  /**
   * The camera that looks at the cube.
   *
   * It mirrors the model camera's ORIENTATION but not its distance or
   * target: the cube is always centred and always the same size, which
   * is the point of it.
   */
  const viewProjectionFor = (
    azimuth: number, elevation: number, roll: number,
  ): Matrix => {
    const horizontal = Math.cos(elevation)
    const eye: Vector3 = [
      horizontal * Math.cos(azimuth) * 4,
      horizontal * Math.sin(azimuth) * 4,
      Math.sin(elevation) * 4,
    ]

    // Up, turned by the roll about the view axis — so the cube leans
    // exactly as the model does.
    const forward: Vector3 = [-eye[0] / 4, -eye[1] / 4, -eye[2] / 4]
    const worldUp: Vector3 = [
      -Math.sin(elevation) * Math.cos(azimuth),
      -Math.sin(elevation) * Math.sin(azimuth),
      Math.cos(elevation),
    ]
    const cosRoll = Math.cos(roll)
    const sinRoll = Math.sin(roll)
    const dot =
      forward[0] * worldUp[0] + forward[1] * worldUp[1] + forward[2] * worldUp[2]
    const cross: Vector3 = [
      forward[1] * worldUp[2] - forward[2] * worldUp[1],
      forward[2] * worldUp[0] - forward[0] * worldUp[2],
      forward[0] * worldUp[1] - forward[1] * worldUp[0],
    ]
    const up: Vector3 = [
      worldUp[0] * cosRoll + cross[0] * sinRoll + forward[0] * dot * (1 - cosRoll),
      worldUp[1] * cosRoll + cross[1] * sinRoll + forward[1] * dot * (1 - cosRoll),
      worldUp[2] * cosRoll + cross[2] * sinRoll + forward[2] * dot * (1 - cosRoll),
    ]

    // ORTHOGRAPHIC, deliberately. Under perspective the cube's near
    // corner swells and the far one shrinks, which reads as the cube
    // being a different size depending on which way it is turned — the
    // opposite of a stable orientation readout.
    return matrixMultiply(
      orthographic(VIEW_EXTENT * 2, 1, -10, 10),
      lookAt(eye, [0, 0, 0], up),
    )
  }

  return {
    get hovered() { return state.hovered },
    set hovered(region: CubeRegion | null) { state.hovered = region },

    render(azimuth, elevation, roll) {
      const viewProjection = viewProjectionFor(azimuth, elevation, roll)
      lastViewProjection = viewProjection

      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.enable(gl.DEPTH_TEST)
      // Culling ON, and it MATTERS now: the two-plate magic (cube-spec.md
      // §2.1) depends on each plate showing only from its own side. The
      // small front plate faces OUT (shown from outside); the large back
      // plate faces IN (shown from inside, seen through the opposite
      // face's gaps). Front and back plates are wound oppositely, so
      // back-face culling keeps exactly one visible per side.
      //
      // Corner discs are double-sided in intent, but a single disc has one
      // winding; culling could hide it from one side. They are re-drawn
      // with culling off below so they read from every angle.
      gl.enable(gl.CULL_FACE)
      gl.cullFace(gl.BACK)

      gl.useProgram(program)
      gl.bindVertexArray(vertexArray)
      gl.uniformMatrix4fv(uniforms.viewProjection, false, viewProjection)

      // One flat draw per part. No shell, no two-pass, no polygon offset —
      // the parts are detached and never overlap, so the depth buffer
      // sorts them and there is nothing to z-fight. Panels carry their DOM
      // label; corner discs are a plain lighter colour.
      for (const batch of batches) {
        const color =
          batch.region.kind === "corner" ? CORNER_COLOR
            : batch.region.kind === "back" ? BACK_COLOR
              : FACE_COLOR
        gl.uniform3f(uniforms.tint, color[0], color[1], color[2])
        gl.uniform1f(
          uniforms.highlighted,
          state.hovered?.id === batch.region.id ? 1 : 0,
        )
        gl.uniform1f(uniforms.labelled, batch.label ? 1 : 0)
        if (batch.label) {
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, batch.label.texture)
          gl.uniform1i(uniforms.label, 0)
        }
        gl.drawArrays(gl.TRIANGLES, batch.offset, batch.count)
      }

      gl.bindVertexArray(null)
    },

    pick(x, y) {
      // Screen to clip. The Y flip is the usual one: pointer coordinates
      // grow downward, clip space upward.
      const clipX = (x / (canvas.width / pixelSize)) * 2 - 1
      const clipY = 1 - (y / (canvas.height / pixelSize)) * 2

      const inverse = invert(lastViewProjection)
      // Singular only if the projection collapsed, which would mean the
      // control has no size — nothing to pick.
      if (!inverse) return null

      const unproject = (z: number): Vector3 => {
        const w =
          inverse[3]! * clipX + inverse[7]! * clipY + inverse[11]! * z + inverse[15]!
        return [
          (inverse[0]! * clipX + inverse[4]! * clipY + inverse[8]! * z + inverse[12]!) / w,
          (inverse[1]! * clipX + inverse[5]! * clipY + inverse[9]! * z + inverse[13]!) / w,
          (inverse[2]! * clipX + inverse[6]! * clipY + inverse[10]! * z + inverse[14]!) / w,
        ]
      }

      const near = unproject(-1)
      const far = unproject(1)
      const direction: Vector3 = [
        far[0] - near[0], far[1] - near[1], far[2] - near[2],
      ]

      return pickCube(regions, near, direction)
    },

    resize(size, devicePixelRatio) {
      pixelSize = devicePixelRatio
      canvas.width = Math.max(1, Math.round(size * devicePixelRatio))
      canvas.height = Math.max(1, Math.round(size * devicePixelRatio))
    },

    dispose() {
      for (const batch of batches) {
        if (batch.label) disposeCubeFaceTexture(gl, batch.label)
      }
      gl.deleteBuffer(positionBuffer)
      gl.deleteBuffer(uvBuffer)
      gl.deleteVertexArray(vertexArray)
      gl.deleteProgram(program)
    },
  }
}

function buildProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)

  const program = gl.createProgram()
  if (!program) throw new Error("could not create the view cube program")
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`view cube shader link failed: ${gl.getProgramInfoLog(program)}`)
  }

  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  return program
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error("could not create a view cube shader")
  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`view cube shader compile failed: ${gl.getShaderInfoLog(shader)}`)
  }
  return shader
}
