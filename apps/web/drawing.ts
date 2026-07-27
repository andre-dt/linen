// =====================================================================
// apps/web/drawing.ts — THE DRAWING LOOP.
//
// What turns mouse clicks into curves. Pick a tool, click points, watch
// the shape follow the cursor, click again to commit. The Onshape
// experience, and the reason a sketch feels like drawing rather than
// like filling in a form.
//
// A TOOL IS "HOW MANY CLICKS, AND WHAT DO THEY MEAN"
// -------------------------------------------------
// Every tool reduces to the same shape: collect N points, and given the
// points so far plus the cursor, produce the curve to preview. Declaring
// that as DATA rather than as a state machine per tool is what keeps a
// new tool to a table entry — the same discipline the feature metadata
// follows.
//
// Two arities exist:
//   fixed   line (2), rectangle (2), circle (2), arc (3), point (1)
//   open    spline — keeps taking points until the user ends it
//
// WHY THIS IS NOT IN THE PANEL MACHINE
// ------------------------------------
// The panel machine in @linen/cad models the COMMAND: which step, which
// fields, what gets persisted. This models the GESTURE: half-finished
// clicks that may never become anything. A rubber band is not a value —
// it exists for a few frames and is discarded. Keeping it out of the
// panel state is what stops every mouse move from being a state
// transition the command has to reason about.
//
// The two meet exactly once: when a curve completes, it is handed over
// as a finished value. Everything before that is local.
// =====================================================================

import type { SketchCurve, SketchPoint } from "@linen/viewer"

// =====================================================================
// 1. TOOLS
// =====================================================================

export type ToolId =
  | "line" | "rectangle" | "circle" | "arc" | "spline" | "polygon" | "point"

interface ToolDefinition {
  readonly id: ToolId
  readonly label: string
  /** Clicks needed. Null means open-ended: the user decides when to stop. */
  readonly points: number | null
  /** What to show given the points placed so far plus the live cursor.
   *  Called every mouse move, so it must be cheap and total — a
   *  half-defined shape returns null rather than throwing. */
  build(points: readonly SketchPoint[], cursor: SketchPoint | null): SketchCurve | null
  /** Prompt for the NEXT click, by index. Guides without a manual. */
  hint(placed: number): string
}

/** How many sides a polygon gets until the panel offers a field for it.
 *  Six is the shape people draw when they draw a polygon. */
const DEFAULT_POLYGON_SIDES = 6

const TOOLS: Record<ToolId, ToolDefinition> = {
  line: {
    id: "line", label: "Line", points: 2,
    build: (placed, cursor) => {
      const from = placed[0]
      const to = placed[1] ?? cursor
      return from && to ? { kind: "line", from, to } : null
    },
    hint: (placed) => (placed === 0 ? "Click the start point" : "Click the end point"),
  },

  rectangle: {
    id: "rectangle", label: "Rectangle", points: 2,
    build: (placed, cursor) => {
      const from = placed[0]
      const to = placed[1] ?? cursor
      return from && to ? { kind: "rectangle", from, to } : null
    },
    hint: (placed) => (placed === 0 ? "Click a corner" : "Click the opposite corner"),
  },

  circle: {
    id: "circle", label: "Circle", points: 2,
    build: (placed, cursor) => {
      const center = placed[0]
      const rim = placed[1] ?? cursor
      if (!center || !rim) return null
      // The second click sets the radius by distance, so the circle
      // grows under the cursor rather than needing a typed number.
      return {
        kind: "circle",
        center,
        radius: Math.hypot(rim.u - center.u, rim.v - center.v),
      }
    },
    hint: (placed) => (placed === 0 ? "Click the centre" : "Drag out the radius"),
  },

  polygon: {
    id: "polygon", label: "Polygon", points: 2,
    build: (placed, cursor) => {
      const center = placed[0]
      const rim = placed[1] ?? cursor
      if (!center || !rim) return null
      return {
        kind: "polygon",
        center,
        radius: Math.hypot(rim.u - center.u, rim.v - center.v),
        sides: DEFAULT_POLYGON_SIDES,
      }
    },
    hint: (placed) => (placed === 0 ? "Click the centre" : "Drag out the size"),
  },

  arc: {
    id: "arc", label: "Arc", points: 3,
    build: (placed, cursor) => {
      const from = placed[0]
      const to = placed[1] ?? cursor
      if (!from || !to) return null
      // With only two points the bulge is unknown, so show the chord —
      // it reads as "the arc will span this", not as a finished line.
      const through = placed[2] ?? (placed.length >= 2 ? cursor : null)
      if (!through) return { kind: "line", from, to }
      return { kind: "arc", from, to, through }
    },
    hint: (placed) =>
      placed === 0 ? "Click the start" : placed === 1 ? "Click the end" : "Click a point on the arc",
  },

  spline: {
    id: "spline", label: "Spline", points: null,
    build: (placed, cursor) => {
      const points = cursor ? [...placed, cursor] : [...placed]
      return points.length >= 2 ? { kind: "spline", points, closed: false } : null
    },
    hint: (placed) =>
      placed < 2 ? "Click control points" : "Click more, or press Enter to finish",
  },

  point: {
    id: "point", label: "Point", points: 1,
    build: (placed, cursor) => {
      const at = placed[0] ?? cursor
      return at ? { kind: "point", at } : null
    },
    hint: () => "Click to place a point",
  },
}

export const toolDefinition = (id: ToolId): ToolDefinition => TOOLS[id]
export const TOOL_IDS = Object.keys(TOOLS) as readonly ToolId[]

// =====================================================================
// 2. THE GESTURE IN PROGRESS
// =====================================================================

export interface DrawingState {
  readonly tool: ToolId
  /** Clicks committed so far in THIS curve. */
  readonly points: readonly SketchPoint[]
}

export const beginDrawing = (tool: ToolId): DrawingState => ({ tool, points: [] })

/** What to draw right now: the shape implied by the clicks plus cursor. */
export const previewOf = (
  state: DrawingState,
  cursor: SketchPoint | null,
): SketchCurve | null => toolDefinition(state.tool).build(state.points, cursor)

export const hintOf = (state: DrawingState): string =>
  toolDefinition(state.tool).hint(state.points.length)

/**
 * A click lands.
 *
 * Returns the next gesture state, plus the finished curve when this
 * click completed one. The caller commits that curve and the gesture
 * resets to the same tool — because in Onshape choosing "line" once lets
 * you draw many lines, and returning to the toolbar after each would be
 * unusable.
 */
export interface ClickOutcome {
  readonly state: DrawingState
  /** Non-null exactly when a curve just completed. */
  readonly completed: SketchCurve | null
}

export const placePoint = (
  state: DrawingState,
  point: SketchPoint,
): ClickOutcome => {
  const definition = toolDefinition(state.tool)
  const points = [...state.points, point]

  // Open-ended tools never complete on a click; only `finishDrawing` ends
  // them.
  if (definition.points === null) {
    return { state: { ...state, points }, completed: null }
  }

  if (points.length < definition.points) {
    return { state: { ...state, points }, completed: null }
  }

  const completed = definition.build(points, null)
  // Degenerate input — a zero-radius circle from a double click — is
  // dropped rather than committed. Persisting it would put a curve in
  // the model the user cannot see or select.
  return {
    state: beginDrawing(state.tool),
    completed: completed && isDegenerate(completed) ? null : completed,
  }
}

/**
 * Ends an open-ended tool (Enter, or a double click on a spline).
 * Returns the curve if enough points were placed, null otherwise.
 */
export const finishDrawing = (state: DrawingState): ClickOutcome => {
  const completed = toolDefinition(state.tool).build(state.points, null)
  return {
    state: beginDrawing(state.tool),
    completed: completed && isDegenerate(completed) ? null : completed,
  }
}

/** Backs out the last click without leaving the tool. */
export const undoPoint = (state: DrawingState): DrawingState => ({
  ...state,
  points: state.points.slice(0, -1),
})

/**
 * Curves too small to be real: a click that did not move, a circle with
 * no radius. Below this the user almost certainly double-clicked or
 * misclicked, and committing it creates geometry they will then have to
 * hunt down and delete.
 */
const MINIMUM_SIZE = 1e-6

const isDegenerate = (curve: SketchCurve): boolean => {
  switch (curve.kind) {
    case "line":
    case "rectangle":
      return (
        Math.abs(curve.to.u - curve.from.u) < MINIMUM_SIZE &&
        Math.abs(curve.to.v - curve.from.v) < MINIMUM_SIZE
      )
    case "circle":
    case "polygon":
      return curve.radius < MINIMUM_SIZE
    case "arc":
      return (
        Math.abs(curve.to.u - curve.from.u) < MINIMUM_SIZE &&
        Math.abs(curve.to.v - curve.from.v) < MINIMUM_SIZE
      )
    case "spline":
      return curve.points.length < 2
    case "point":
      return false
  }
}

// =====================================================================
// 3. PERSISTING
// =====================================================================

/**
 * Converts a drawn curve into the form the command persists.
 *
 * Coordinates become STRINGS because every value in the model is an
 * expression — that is what makes it parametric. A drawn `12.5` is the
 * literal expression "12.5", which the user can later replace with
 * `width / 2` and have the sketch follow.
 *
 * Rounded to a sane number of decimals: a click produces a float with
 * seventeen digits of noise, and writing that into git makes every diff
 * unreadable.
 */
const DECIMALS = 4
const text = (value: number): string =>
  String(Number(value.toFixed(DECIMALS)))

const point2 = (point: SketchPoint): { x: string; y: string } => ({
  x: text(point.u),
  y: text(point.v),
})

export const persistCurve = (curve: SketchCurve): Record<string, unknown> => {
  switch (curve.kind) {
    case "line":
      return { kind: "line", points: [point2(curve.from), point2(curve.to)] }
    case "rectangle":
      return { kind: "rectangle", corners: [point2(curve.from), point2(curve.to)] }
    case "circle":
      return { kind: "circle", center: [point2(curve.center)], radius: text(curve.radius) }
    case "polygon":
      return {
        kind: "polygon",
        center: [point2(curve.center)],
        radius: text(curve.radius),
        sides: String(curve.sides),
        fit: "inscribed",
      }
    case "arc":
      return {
        kind: "arc",
        points: [point2(curve.from), point2(curve.to), point2(curve.through)],
      }
    case "spline":
      return {
        kind: "spline",
        points: curve.points.map(point2),
        closed: curve.closed,
      }
    case "point":
      return { kind: "point", points: [point2(curve.at)] }
  }
}
