// =====================================================================
// packages/viewer/backend.ts
//
// Picks a graphics backend. WebGPU when the browser has it, WebGL2
// otherwise.
//
// A missing WebGPU is the expected path on older browsers, not an
// error: this returns a WebGL2 backend instead of throwing. It throws
// only when neither is available, which genuinely means the app cannot
// run.
// =====================================================================

import type { Backend, BackendKind, BackendLimits } from "./index"

export async function createBackend(
  canvas: HTMLCanvasElement,
  // WebGL2 is the DEFAULT until the WebGPU renderer exists.
  //
  // Preferring WebGPU here while createScene implements only WebGL2 made
  // the pair disagree: on a machine with a WebGPU adapter this returned a
  // backend the scene then refused, and the viewport died with "the
  // WebGPU renderer is not implemented yet". A machine WITHOUT an adapter
  // fell through to WebGL2 and worked — so it broke only on real GPUs,
  // which is the worst way for it to break.
  //
  // Flip this back to "webgpu" in the same change that lands the WebGPU
  // path in scene.ts, never before.
  preference: BackendKind = "webgl2",
): Promise<Backend> {
  if (preference === "webgpu") {
    const webgpu = await tryWebGpu(canvas)
    if (webgpu) return webgpu
  }

  const webgl = tryWebGl2(canvas)
  if (webgl) return webgl

  throw new Error(
    "no usable graphics backend: this browser supports neither WebGPU nor WebGL2",
  )
}

// =====================================================================
// WEBGPU
// =====================================================================

async function tryWebGpu(canvas: HTMLCanvasElement): Promise<Backend | null> {
  const gpu = navigator.gpu
  if (!gpu) return null

  // `requestAdapter` resolves to null rather than rejecting when no
  // adapter is usable — a blocked driver, a headless context, a
  // browser flag.
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) return null

  const device = await adapter.requestDevice()
  const context = canvas.getContext("webgpu")
  if (!context) return null

  const format = gpu.getPreferredCanvasFormat()
  context.configure({
    device,
    format,
    // Picking reads back from a texture, which requires the copy usage.
    // Configuring it here avoids reconfiguring mid-session.
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    alphaMode: "opaque",
  })

  const limits: BackendLimits = {
    maxTextureSize: adapter.limits.maxTextureDimension2D,
    maxBufferSize: adapter.limits.maxBufferSize,
    supportsComputeShaders: true,
    supportsTimestampQuery: adapter.features.has("timestamp-query"),
  }

  return {
    kind: "webgpu",
    canvas,
    limits,
    device,
    context,
    format,
    dispose() {
      device.destroy()
    },
  } as WebGpuBackend
}

export interface WebGpuBackend extends Backend {
  readonly kind: "webgpu"
  readonly device: GPUDevice
  readonly context: GPUCanvasContext
  readonly format: GPUTextureFormat
}

// =====================================================================
// WEBGL2
// =====================================================================

function tryWebGl2(canvas: HTMLCanvasElement): Backend | null {
  const gl = canvas.getContext("webgl2", {
    // MSAA. Every edge in this scene is a thin line — plane borders,
    // sketch curves, the origin sphere's silhouette — and those are
    // exactly what aliases worst without it.
    antialias: true,
    depth: true,
    // NOT preserved.
    //
    // It was set for readback picking, but picking is a ray cast in
    // JavaScript now and never reads the framebuffer. Meanwhile many
    // drivers silently DISABLE multisampling when this is on, because a
    // preserved buffer cannot be a multisample one — so it was costing
    // the anti-aliasing above and buying nothing.
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  })
  if (!gl) return null

  const limits: BackendLimits = {
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    // WebGL2 has no equivalent query; this is the practical ceiling
    // before drivers start refusing allocations.
    maxBufferSize: 256 * 1024 * 1024,
    supportsComputeShaders: false,
    supportsTimestampQuery: false,
  }

  return {
    kind: "webgl2",
    canvas,
    limits,
    gl,
    dispose() {
      gl.getExtension("WEBGL_lose_context")?.loseContext()
    },
  } as WebGl2Backend
}

export interface WebGl2Backend extends Backend {
  readonly kind: "webgl2"
  readonly gl: WebGL2RenderingContext
}
