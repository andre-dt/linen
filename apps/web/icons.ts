// =====================================================================
// apps/web/icons.ts — the one place lucide is imported.
//
// WHY THIS FILE EXISTS
// --------------------
// `lucide-solid` re-exports ~1750 icons from a single barrel with no
// side-effect-free marking Vite's dev server trusts, so both
// `import { X } from "lucide-solid"` and `import * as Icons` pull the
// entire set into the module graph. In dev that is ~1750 modules to
// transform; in a production build the `import *` form defeats
// tree-shaking outright.
//
// The fix is deep imports: every icon has its own module, so importing
// it directly skips the barrel. We do that once, here, and the rest of
// the app imports named icons from this file. No component ever touches
// "lucide-solid" again — a lint rule can enforce that.
//
// Adding an icon is two lines here and nowhere else.
// =====================================================================

// Deep paths, one module each. This is the whole optimization.
import Box from "lucide-solid/icons/box"
import PenLine from "lucide-solid/icons/pen-line"
import RotateCw from "lucide-solid/icons/rotate-cw"
import Layers from "lucide-solid/icons/layers"
import Spline from "lucide-solid/icons/spline"
import CircleDot from "lucide-solid/icons/circle-dot"
import Triangle from "lucide-solid/icons/triangle"
import Package from "lucide-solid/icons/package"
import Circle from "lucide-solid/icons/circle"
import Grid3x3 from "lucide-solid/icons/grid-3x3"
import FlipHorizontal from "lucide-solid/icons/flip-horizontal"
import Square from "lucide-solid/icons/square"
import X from "lucide-solid/icons/x"
import Check from "lucide-solid/icons/check"
import ChevronDown from "lucide-solid/icons/chevron-down"
import MousePointerClick from "lucide-solid/icons/mouse-pointer-click"
import MoveVertical from "lucide-solid/icons/move-vertical"
import Plus from "lucide-solid/icons/plus"
import ArrowLeftRight from "lucide-solid/icons/arrow-left-right"
import ListTree from "lucide-solid/icons/list-tree"
import Eye from "lucide-solid/icons/eye"
import EyeOff from "lucide-solid/icons/eye-off"
import AlertTriangle from "lucide-solid/icons/triangle-alert"
import CircleAlert from "lucide-solid/icons/circle-alert"
import Variable from "lucide-solid/icons/variable"
import Cloud from "lucide-solid/icons/cloud"
import CloudOff from "lucide-solid/icons/cloud-off"

export {
  Box, PenLine, RotateCw, Layers, Spline, CircleDot, Triangle, Package,
  Circle, Grid3x3, FlipHorizontal, Square, X, Check, ChevronDown,
  MousePointerClick, MoveVertical, Plus, ArrowLeftRight, ListTree, Eye,
  EyeOff, AlertTriangle, CircleAlert, Variable, Cloud, CloudOff,
}

// Command icons are NOT mapped here: a feature's metadata names a lucide
// icon directly (e.g. "box", "pen-line") and widgets/lucide-icon.tsx
// loads it dynamically. That keeps the web app dumb — adding a feature
// never touches this file.
