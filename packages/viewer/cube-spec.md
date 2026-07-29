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
- **Back plate (plain):** a rounded-rect that faces INWARD (toward the cube
  centre). Its size is **solved so its rounded corners reach the corner discs'
  FAR rim** (the disc edge toward the cube corner) — the plate covers the whole
  disc width. The disc-rim far point, projected onto the plate's plane, lands at
  a plate-diagonal coordinate the geometry gives as
  `discFarRim = (CORNER_DISTANCE + CORNER_RADIUS·?)` — in practice it is
  computed from the disc and equals ≈ `0.888` at the default constants. The back
  plate's diagonal corner tip `BACK_PANEL_HALF + BACK_PANEL_CORNER_RADIUS/√2` is
  set equal to that. It is a **solid plain colour, no label** — the backdrop
  seen through the opposite face's gaps.

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
| `PANEL_HALF` | Half-width of the small FRONT plate (straight run before arc) | `0.55` |
| `PANEL_CORNER_RADIUS` | Rounding radius of the front plate's corners | `0.16` |
| `BACK_PANEL_HALF` | Half-width of the BACK plate — sized so its corner reaches the disc CENTRE | `0.662` (derived) |
| `BACK_PANEL_CORNER_RADIUS` | Rounding radius of the back plate's corners | `0.16` |
| `PLATE_SEPARATION` | Depth gap between a face's front and back plates | `0.004` |
| `CORNER_RADIUS` | Radius of a corner circle | `0.275` |
| `CORNER_DISTANCE` | Distance from cube centre to the disc centre, along the body diagonal | `1.343` |
| `CIRCLE_SEGMENTS` | Triangle fan segments per circle / rounded arc | `24` |

A panel reaches `PANEL_HALF + PANEL_CORNER_RADIUS` ≈ `0.71` from the face centre
along each in-plane axis. With `HALF = 1.0` that leaves a **visible void gap**
of ≈ `0.29` on each side between adjacent panels — the detached-panel look.

**Corner placement is solved, not guessed.** The disc must sit OUT AT THE CORNER
(near `±HALF` on all three axes), not pulled into the hollow interior. Take the
three adjacent panels' nearest rounded-corner tips — for the +X+Y+Z corner these
are `(HALF, c, c)`, `(c, HALF, c)`, `(c, c, HALF)` where
`c = PANEL_HALF + PANEL_CORNER_RADIUS/√2`. The disc centre is their **centroid**
(equidistant to all three), which lands on the body diagonal at distance
`CORNER_DISTANCE ≈ 1.343`, and `CORNER_RADIUS ≈ 0.275` is the distance from that
centroid to each tip — so the disc's rim **touches all three panels**. If the
panel constants change, these two are re-derived from that construction.

These are **display** values, tuned by eye against the widget; they are not
lengths in the model. They live as named constants and change here first.

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

Unchanged from today: an **orthographic** camera that mirrors the model
camera's **orientation** (azimuth, elevation, roll) but not its distance or
target — the cube is always centred and the same size. Orthographic so the
cube's size does not swell/shrink with turn.

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
