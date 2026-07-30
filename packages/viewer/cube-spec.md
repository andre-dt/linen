# View Cube — Specification

The navigation cube in the corner of the viewport. A **hollow, assembled**
control in the Onshape style: it is NOT a solid with a classified surface. It is
a small set of detached parts floating in cube space. This spec is the source of
truth — the implementation follows it, and any change is made HERE first.

## 1. What it is

A cube-shaped arrangement of **detached parts**:

- **6 face panels** — one per cube face (+X, −X, +Y, −Y, +Z, −Z).
- **8 corner circles** — one per cube corner (±X, ±Y, ±Z sign combinations).

There is **nothing else**. No shell, no bevels, no edges, no continuous surface.
The cube is **hollow**: between the panels and around the corners is **empty
space** (void) — no geometry is drawn there and nothing can be hit there.

## 2. Parts

### 2.1 Face panels (6)

Each face position has **two concentric rounded-rectangles on the same face
plane**, distinguished by which way they face (Onshape's exact behaviour,
confirmed from a screenshot):

- **Front plate (small, labelled):** a rounded-rect of half-width `PANEL_HALF`
  (rounded by `PANEL_CORNER_RADIUS`) that faces OUTWARD along the face normal. It
  is what you see and click when that face is toward you. It is **smaller than
  the cube face**, so there is a **void gap around it** — through that gap you
  see, and click through to, whatever is behind. It carries the face's **DOM
  label texture** (§5).
  - **The front plate does NOT touch the corner discs** — there is a clear gap
    between the plate's corners and each disc (Onshape does this). The plate's
    diagonal corner tip stays SHORT of the disc's near rim by a margin
    (`PANEL_DISC_GAP`).
- **Back plate (plain, MERGED silhouette):** faces INWARD (toward the cube
  centre). Its outline is **NOT a plain rounded-rect** — it is the **union of the
  front panel's footprint AND the four corner discs**, projected onto the face
  plane. So the solid gray backdrop bulges out at each corner where a disc sits,
  and reads as one continuous solid = panel + 4 discs merged. This is why, from
  the far side, "the contour matches the opposite face + the discs" (confirmed
  from an Onshape screenshot). No label, plain solid colour.
  - The four discs each project to a circle on the face plane, centred at the
    panel's four corners' diagonal direction, at the disc's projected radius.
    The back plate mesh is the panel rounded-rect plus these four circles, all
    filled as one silhouette (overlapping fills are fine — it is one solid).

So looking at a face you see: its own small labelled front plate, and — through
the gaps around it — the large plain back plate of the OPPOSITE face filling the
whole frame behind it.

- Both plates are centred on the face plane at distance `HALF` from the cube
  centre. They are **back-to-back**, facing opposite directions, so face culling
  shows the front plate from outside and the back plate from inside. A tiny
  depth separation (`PLATE_SEPARATION`) keeps them from z-fighting.
- All six faces behave **identically** — "Right" above is just an example.
- Panels are **separate meshes**; removing a face's pair leaves the others
  unchanged.

### 2.2 Corner circles (8)

- Each corner is a **flat circle** (a filled disc) sitting at a cube corner.
- Radius `CORNER_RADIUS`.
- Position: centred on the corner point, pulled in from the sharp corner toward
  the cube centre by `CORNER_INSET` so it sits in the gap the rounded panel
  corners leave.
- **Two-sided, like the panels (RESOLVED):** the disc has a FRONT and a BACK.
  - **Front face** (its normal points OUT along the corner diagonal, toward you
    when you face that corner): visible — solid colour, lights on hover — and
    **pickable**.
  - **Back face** (when that corner is on the far side): **invisible AND not
    pickable**. A ray from behind passes straight through it, like a panel's
    open gap. So a disc only appears, and only responds to clicks, when you are
    facing its corner.
  - Achieved the same way as the plates: the disc is single-sided (back-face
    culled for drawing) and picking ignores hits on its back face (rejects a
    ray that strikes the disc from behind — i.e. where the ray direction and the
    disc's outward normal agree).
- **Orientation (RESOLVED):** the disc lies in the plane **perpendicular to the
  corner's body diagonal** — its outward normal is the normalised corner
  direction `normalize(±1,±1,±1)`. It is symmetric to all three adjacent faces
  (not billboarded to the camera, not lying in a single face plane). It turns
  with the cube.
- **Placement rule (RESOLVED — Onshape-like):** the disc "touches all 3
  panels." Its centre sits on the body diagonal at `CORNER_DISTANCE` from the
  cube centre, and `CORNER_RADIUS` / `CORNER_DISTANCE` are chosen so the disc's
  rim reaches toward the nearest rounded corner of each of the three adjacent
  panels — visually bridging the gap between them. Concretely: the three
  adjacent panels each have a rounded corner pointing at this diagonal; the disc
  is sized and positioned so its edge meets those three corners. These two
  constants are solved/tuned together against the live widget so the touch reads
  cleanly.
- Corner circles are **clickable pick targets** (snap to that corner's
  isometric-ish view).

### 2.3 Edges — NONE

- There are **no edge parts**. No geometry, no rendering, nothing clickable
  along the cube edges.
- The edge regions are **void**: empty space between adjacent panels and between
  the corner circles.

## 3. Layout constants

All in the cube's own unit space (the cube spans roughly −1..+1 before the
orthographic camera scales it to the widget).

| Constant | Meaning | Default |
|---|---|---|
| `HALF` | Distance from centre to each panel plane | `1.0` |
| `PANEL_HALF` | Half-width the disc placement is anchored to (straight run before arc) | `0.55` |
| `PANEL_CORNER_RADIUS` | Rounding radius of the front plate's corners | `0.22` |
| `PANEL_DISC_GAP` | Gap the FRONT plate is pulled in by so it never touches the discs | `0.09` |
| `FRONT_PANEL_HALF` | Half-width of the front plate AS DRAWN — `PANEL_HALF − PANEL_DISC_GAP` | `0.46` (derived) |
| `BACK_PANEL_HALF` | Half-width of the BACK plate — sized so its rounded corner reaches the disc CENTRE line | `0.691` (derived) |
| `BACK_PANEL_CORNER_RADIUS` | Rounding radius of the back plate's corners | `0.16` |
| `PLATE_SEPARATION` | Depth gap between a face's front and back plates | `0.004` |
| `CORNER_RADIUS` | Radius of a corner circle | `0.240` (derived) |
| `CORNER_DISTANCE` | Distance from cube centre to the disc centre, along the body diagonal | `1.392` (derived) |
| `CIRCLE_SEGMENTS` | Triangle fan segments per circle / rounded arc | `24` |

The disc placement is anchored to `PANEL_HALF`; the **drawn** front plate is
`FRONT_PANEL_HALF = PANEL_HALF − PANEL_DISC_GAP`, so only the visible plate backs
off from the discs while the discs stay put (cube-spec.md §2.1). The drawn front
plate reaches `FRONT_PANEL_HALF + PANEL_CORNER_RADIUS` ≈ `0.68` from the face
centre along each in-plane axis. With `HALF = 1.0` that leaves a **visible void
gap** on each side between adjacent panels — the detached-panel look — and the
larger back plate (reach ≈ `0.85`) shows through it, so a ray in the gap punches
through to the opposite face's back plate.

**Corner placement is solved, not guessed.** The disc must sit OUT AT THE CORNER
(near `±HALF` on all three axes), not pulled into the hollow interior. Take the
three adjacent panels' nearest rounded-corner tips — for the +X+Y+Z corner these
are `(HALF, c, c)`, `(c, HALF, c)`, `(c, c, HALF)` where
`c = PANEL_HALF + PANEL_CORNER_RADIUS/√2`. The disc centre is their **centroid**
(equidistant to all three), which lands on the body diagonal at distance
`CORNER_DISTANCE ≈ 1.392`, and `CORNER_RADIUS ≈ 0.240` is the distance from that
centroid to each tip — so the disc's rim **touches all three panels**. If the
panel constants change, these two are re-derived from that construction.

These are **display** values, tuned by eye against the widget; they are not
lengths in the model. They live as named constants and change here first.

**These invariants are unit-tested** (`cube.test.ts`): the part inventory (§2),
the void gap and single-sided punch-through picking (§4), and that the derived
corner constants keep the disc rim on the three adjacent panel tips (this §). A
constant change that broke the construction would fail a test rather than only
look wrong in the widget.

## 4. Hollow behaviour & picking

This is the defining property. Because the cube is hollow with void edges:

1. **Hittable parts:** the 6 front plates, the 6 back plates, and the 8 corner
   circles. A front plate and its paired back plate resolve to the **same face
   direction** (clicking either the Right front plate or the Left back plate you
   see through Right's gaps means "look from Right"/"look from Left" respectively
   — each plate belongs to its own face). No edges are hittable.
2. **No edge hits.** A ray through a gap hits no edge because there is none.
3. **Punch-through is real and intended.** A ray through the void gap around a
   front plate continues and hits what is behind — typically the large back
   plate of the opposite face, or a corner circle. Facing Right, clicking in the
   gap around the Right front plate hits the Left face's back plate.
4. **Nearest hit wins.** When a ray hits more than one part, the closest
   intersection along the ray wins — compared by ray `t`, not by a shell.
5. **Back faces are not pickable.** Every part is single-sided: a ray that
   strikes a part from behind (ray direction agreeing with the part's outward
   normal) is ignored, so it passes through to whatever is beyond. This is what
   makes a far corner disc — and the open gaps of a front plate — click-through.
   The large BACK plates ARE meant to be hit from the inside, so their outward
   normal points inward (they are "facing" the ray that reaches them through the
   opposite face's gaps); the back-face test uses each part's own outward normal
   accordingly.
5. Picking is a **ray/geometry test in TypeScript** (like the rest of the
   viewer), returning which part was hit. What is drawn and what is picked use
   the **same geometry**, so they cannot disagree.

## 5. Appearance

- **Front plates:** flat, one uniform body colour, no lighting term (it is an
  orientation readout, not a lit object). The DOM label texture (the face's name
  rendered as HTML, uploaded via `texElementImage2D`) is composited onto it.
  Rounded-rect shape comes from the **geometry**, not a texture mask.
- **Back plates:** flat, plain solid colour, **no label** — a touch different
  from the front plates (slightly darker/grayer) so the backdrop reads as "the
  far side" rather than another front panel.
  - **Label span:** the label texture maps across `±LABEL_HALF_SPAN` of the
    panel in cube units, centred. It must be **≥ the panel's full extent**
    (`PANEL_HALF + PANEL_CORNER_RADIUS`) so the whole word fits inside the
    panel; the DOM element's own CSS (font size, padding) controls how large
    the glyphs sit within that texture, not the UV span. Default:
    `LABEL_HALF_SPAN = PANEL_HALF + PANEL_CORNER_RADIUS`.
- **Corner circles:** flat, a single colour, slightly distinct from the panels
  so the eight corner targets read as their own controls.
- **Hover:** the part under the cursor lights (a brighter tint). Only one part
  lights at a time.
- **No artifacts by construction:** every part is its own clean mesh with no
  shared/classified boundaries, so there are no seams, corner claws, or region
  steps possible.

## 6. Camera

An **orthographic** camera that mirrors the model camera's **orientation**
(azimuth, elevation, roll) but not its distance or target — the cube is always
centred and the same size. Orthographic so the cube's size does not swell/shrink
with turn.

The cube does not own a camera; it is handed the model camera's three angles
each frame and builds its own view matrix from them (`viewProjectionFor`). So
whatever the model camera does, the cube shows — they cannot disagree.

### 6.1 Free tumble

Orbit is **unlimited** — the camera tumbles a full 360° in every direction,
including up and over the poles. There is no turntable clamp on elevation.

- Elevation accumulates freely; past ±90° the derived up vector's `cos(elevation)`
  term goes negative and turns the frame over cleanly, so the view keeps rolling
  instead of gimbal-flipping.
- The single exact pole (`cos(elevation) = 0`) is degenerate — the derived up is
  the zero vector there. A guard substitutes a defined screen-up
  (`[−cos azimuth, −sin azimuth, 0]`) so `lookAt` never collapses. A continuous
  drag only lands exactly on it with measure zero; the guard is for safety, not a
  path the user feels.
- `POLE_LIMIT` (π/2 − 0.01) still exists, but **only** governs orbit's need for a
  defined up during a drag — it is NOT used to clamp a snap target (§6.2).

The same free-tumble math runs in `camera.ts` (the model camera) and in the
cube's own `viewProjectionFor`, including the exact-pole up guard, so the cube
tumbles identically to the model.

### 6.2 Click-to-face snap

Clicking a face / corner / (formerly edge) region snaps the camera to look from
that region's direction, animated over `VIEW_TRANSITION_SECONDS`. The snap lands
the face **square and upright** from ANY tumbled start:

- **Dead-on the pole.** Top and Bottom targets land on the EXACT pole (±π/2), not
  a hair short at `POLE_LIMIT`. A fraction of a degree off-normal doubles a
  plane's grid line and leaves a sliver on the cube; the exact pole is safe
  because the up-vector guard covers the degenerate up it produces.
- **Upright, and Bottom the same way up as Top.** At the bottom pole the derived
  world-up points −Y (the `−sin(elevation)` term flips sign below the equator),
  the opposite of the top pole's +Y — so a bottom view rolled to 0 would read
  upside-down. The bottom-pole target carries a half-turn of roll (π) to bring
  screen-up back to +Y, so "Bottom" reads the same way up as "Top". Every other
  face's target roll is 0.
- **Smooth — no jump, no bump.** Two things are handled so every quantity
  progresses together over the one transition:
  1. *No first-frame jump.* A free tumble can wind the camera into the flipped
     hemisphere. Before the transition, the pose is RECONCILED into the canonical
     (unflipped) branch **without moving the camera** — elevation is reflected
     back over the pole and the half-turn is carried into azimuth and roll, which
     render to the identical frame. So the ease starts from exactly where the
     camera already is.
  2. *No pole bump.* For a pole target the great-circle arc's `atan2` azimuth
     re-derivation is ill-conditioned right at the pole. Pole snaps skip the arc
     and interpolate the angles directly through the pole; the up-vector guard
     covers the singular instant. The per-frame motion is then a smooth bell
     curve (fastest at the pole crossing, by geometry) with no discontinuity.

Azimuth, elevation and roll each ease the **short way** to the target. **These
behaviours are unit-tested** (`camera.test.ts`): unlimited orbit, the up vector
staying unit and defined across a full tumble, dead-on/upright landings for every
face, Bottom reading upright, and the animation being continuous (no first-frame
jump, no spike crossing the pole).

## 7. Open decisions

- **§2.2 corner-circle orientation — RESOLVED:** disc perpendicular to the body
  diagonal, symmetric to all three adjacent faces, sized/placed to touch all
  three panels (Onshape-like). See §2.2.
- **§3 exact constant values** are first-pass guesses, tuned against the live
  widget. Tuning a value is a spec edit here, then a code change — not a code
  change alone.

## 8. Explicitly out of scope / removed

- The old `buildCube` one-solid, 26-region, grid-tessellated classification
  (source of the corner/seam artifacts) — **replaced entirely**.
- Shell pass, bevel/edge geometry, face-panel "stamp over shell" (`FACE_LIFT`,
  polygon offset), region tint tiers — **gone**.
- The arrow controls (nudge/roll) — already removed, not part of this cube.
