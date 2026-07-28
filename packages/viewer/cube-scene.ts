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

import { buildCube, pickCube, CHAMFER, type CubeRegion, type CubeRegionKind } from "./cube"
import { createTextTexture, type TextTexture } from "./text"
import { identity, matrixMultiply, orthographic, lookAt, invert, type Matrix } from "./math"
import type { Vector3 } from "@linen/cad/kernel"

/** Half-extent of the orthographic box the cube is drawn into.
 *
 *  Sized to the CHAMFERED silhouette, not the sharp one. A sharp cube's
 *  corners reach sqrt(3) ~ 1.73, but the chamfer cuts them back, so
 *  reserving the full 1.73 left the cube floating in a third of its own
 *  canvas. 1.48 is that radius plus a hair, measured corner-on where the
 *  silhouette is widest. */
const VIEW_EXTENT = 1.48

/** How much of a face's width the label spans; the rest is margin.
 *
 *  The type size passed to createTextTexture sets the BITMAP's
 *  resolution, not how large the text lands — the quad stretches
 *  whatever it is given across the whole facet. Shrinking the text means
 *  shrinking the patch of UV space sampled from, which is this.
 *
 *  Note the direction: a SMALLER label needs a LARGER divisor, because
 *  the face's edge then maps beyond uv 1 and samples the texture's blank
 *  margin. Getting that backwards made the text grow on two attempts to
 *  shrink it. */
const LABEL_COVERAGE = 0.30

/** How far the face panels are pushed toward the viewer, in depth-buffer
 *  units, so they cover the shell's seams rather than z-fighting them.
 *  Large enough to win everywhere on a 16-bit depth buffer, small enough
 *  not to poke through the bevels at a grazing angle. */
const FACE_LIFT = 24

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
 * Colour per region kind — the cube built up in three passes.
 *
 *   1. the solid, everywhere in BODY
 *   2. the six face panels, stamped darker
 *   3. the eight corner discs, stamped lighter
 *
 * The bevels keep BODY, so they read as the material the panels and
 * discs are set into rather than as a third thing.
 */
const TINT: Record<CubeRegionKind, Vector3> = {
  // Darker than the body, keyed to the HUD panel material: the panel is
  // the recess, the bevel around it the surface it is cut into.
  face: [0.100, 0.138, 0.232],
  edge: BODY,
  // Lighter than the bevels, so the eight corner targets read as the
  // distinct controls they are. With flat shading these tiers are the
  // only thing giving the cube its form, so the step has to be clear.
  corner: [0.290, 0.360, 0.520],
}

interface Batch {
  readonly region: CubeRegion
  readonly offset: number
  readonly count: number
  readonly label: TextTexture | null
}

export const createCubeScene = (canvas: HTMLCanvasElement): CubeScene => {
  const gl = canvas.getContext("webgl2", {
    antialias: true,
    depth: true,
    alpha: true,
    premultipliedAlpha: false,
  })
  if (!gl) throw new Error("the view cube needs WebGL2")

  const program = buildProgram(gl)
  const regions = buildCube()

  // --- geometry, uploaded once ------------------------------------------
  // One buffer for the whole cube, drawn as 26 ranges. Twenty-six small
  // buffers would be twenty-six binds per frame for a shape that never
  // changes.
  // No normals: the shading is flat, so nothing downstream asks which
  // way a facet points. The region's normal is still used below to
  // derive each face's UVs, just never uploaded.
  const positions: number[] = []
  const uvs: number[] = []
  const batches: Batch[] = []

  for (const region of regions) {
    const offset = positions.length / 3
    const count = region.positions.length / 3

    // Built once per face and used twice: its aspect scales the UVs
    // below, and the batch draws with it. Creating it in both places
    // would upload two textures and leak one.
    const labelTexture =
      region.kind === "face"
        ? createTextTexture(gl, region.label, { fontSize: 15, scale: 5 })
        : null

    for (let index = 0; index < region.positions.length; index += 3) {
      positions.push(
        region.positions[index]!,
        region.positions[index + 1]!,
        region.positions[index + 2]!,
      )
    }

    // Only faces carry text, so only faces need UVs.
    //
    // DERIVED per face, not a fixed list. cube.ts winds the positive and
    // negative faces in opposite orders (that is what keeps every normal
    // pointing outward), so one shared UV list had three faces reading
    // correctly and three mirrored or upside-down — Top and Back most
    // visibly. Projecting each vertex onto the face's own screen axes at
    // the pose where it faces the camera gives the right mapping for all
    // six without a table of special cases.
    if (region.kind === "face") {
      const forward = region.normal
      // Screen up for this face: world up, except on the horizontal
      // faces where world up is parallel to the normal and says nothing
      // — those take the Y axis instead, which is what puts Top's label
      // the same way round as the Front view sees it.
      // On the horizontal faces world up is parallel to the normal and
      // says nothing, so the label's orientation has to be chosen. Both
      // read with their up toward +Y — the direction away from a viewer
      // standing at Front — which is the convention every view cube
      // uses: you tip the model forward from Front and Top's text is
      // already the right way up.
      //
      // The sign here was [0, -forward[2], 0] at one point. That made
      // the isometric pose look right by coincidence and left Top
      // upside-down from every other angle; the value below comes from
      // computing where the label's up actually lands, not from
      // matching one screenshot.
      const reference: Vector3 =
        Math.abs(forward[2]) > 0.99 ? [0, forward[2], 0] : [0, 0, 1]
      const right: Vector3 = [
        reference[1] * forward[2] - reference[2] * forward[1],
        reference[2] * forward[0] - reference[0] * forward[2],
        reference[0] * forward[1] - reference[1] * forward[0],
      ]
      const rightLength = Math.hypot(right[0], right[1], right[2])
      const unitRight: Vector3 = [
        right[0] / rightLength, right[1] / rightLength, right[2] / rightLength,
      ]
      const up: Vector3 = [
        forward[1] * unitRight[2] - forward[2] * unitRight[1],
        forward[2] * unitRight[0] - forward[0] * unitRight[2],
        forward[0] * unitRight[1] - forward[1] * unitRight[0],
      ]
      // The face spans +/- inset on both axes, mapped onto [0, 1] with V
      // flipped because texture space grows downward.
      //
      // Multiplied, not divided: see LABEL_COVERAGE.
      //
      // The two axes get DIFFERENT spans, scaled by the bitmap's aspect.
      // A single square span stretched every label to fill a square
      // patch, so "Front" came out wide and squat rather than set in the
      // same proportions the browser drew it in.
      const aspect = labelTexture?.aspect ?? 1
      const spanU = 2 * (1 - CHAMFER) * LABEL_COVERAGE * aspect
      const spanV = 2 * (1 - CHAMFER) * LABEL_COVERAGE
      for (let index = 0; index < region.positions.length; index += 3) {
        const x = region.positions[index]!
        const y = region.positions[index + 1]!
        const z = region.positions[index + 2]!
        const u = (x * unitRight[0] + y * unitRight[1] + z * unitRight[2]) / spanU + 0.5
        const v = (x * up[0] + y * up[1] + z * up[2]) / spanV + 0.5
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
      // Culling OFF; the depth buffer does the hiding.
      //
      // Culling was on and culled the wrong set: the cube showed Back
      // where Front belonged, because cube.ts winds its facets against
      // an outward normal while lookAt builds a right-handed view, and
      // the two conventions disagree about which side is "front".
      //
      // Rather than flip the winding of twenty-six generated facets --
      // and re-derive the edge and corner handedness that was itself
      // hard-won -- the depth test is left to sort them. The cube is
      // twenty-six small facets drawn once a frame; there is no
      // fill-rate argument for culling at this size.
      gl.disable(gl.CULL_FACE)

      gl.useProgram(program)
      gl.bindVertexArray(vertexArray)
      gl.uniformMatrix4fv(uniforms.viewProjection, false, viewProjection)

      // TWO PASSES: the shell first, then the face panels stamped over
      // it.
      //
      // Drawn as one set, the twenty-six facets have to tile exactly,
      // and they do not — adjacent facets are wound independently and
      // their shared edges land a fraction apart, which showed as light
      // slivers along every seam and stray lit pixels at the corner
      // discs. Letting the faces sit PROUD of the shell (see
      // FACE_LIFT) covers those seams instead of fighting them: the
      // shell supplies a continuous solid in the bevel colour, and each
      // face is a darker panel laid on top.
      const ordered = [
        ...batches.filter((batch) => batch.region.kind !== "face"),
        ...batches.filter((batch) => batch.region.kind === "face"),
      ]

      for (const batch of ordered) {
        const tint = TINT[batch.region.kind]
        gl.uniform3f(uniforms.tint, tint[0], tint[1], tint[2])
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
        // Faces win the depth test against the shell they overlap, so
        // no seam of shell can show through a panel. Polygon offset
        // rather than moving the geometry: the positions stay exactly
        // what picking ray-casts against, so what is drawn and what is
        // clicked cannot drift apart.
        if (batch.region.kind === "face") {
          gl.enable(gl.POLYGON_OFFSET_FILL)
          gl.polygonOffset(-1, -FACE_LIFT)
        } else {
          gl.disable(gl.POLYGON_OFFSET_FILL)
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
        if (batch.label) gl.deleteTexture(batch.label.texture)
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
