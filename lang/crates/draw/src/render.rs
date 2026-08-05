// =====================================================================
// cli/render.rs — SEEING WHAT A TEST BUILT.
//
// A test that asserts a box has twelve outward-facing triangles is
// correct and unreadable. This renders the same geometry to a PNG beside
// the test file, so the answer can be checked by eye as well as by
// assertion — and so a wrong solid looks wrong immediately, rather than
// after someone works out which assertion should have caught it.
//
// WRITTEN HERE, NOT LINKED IN
// ---------------------------
// The rasteriser is a few hundred lines of Rust with no dependencies,
// rather than a real renderer, and that is deliberate: image comparison
// needs the SAME bytes on every machine. A GPU or a font library would
// make the output depend on drivers and versions, and a golden image
// that only matches on the machine that made it is worse than none.
//
// THE PROJECTION IS EXACT
// -----------------------
// 2:1 isometric, the one pixel art uses:
//
//   screen_x = x - y
//   screen_y = (x + y) / 2 - z
//
// No sines, no floating point. A true isometric would need cos(45°),
// which is irrational, and the whole kernel exists to avoid deciding
// geometry with irrational numbers. This one is integer arithmetic all
// the way to the pixel — so the picture is reproducible bit for bit.
// =====================================================================

use std::path::Path;

/// A rendered image: 8-bit RGB, row-major from the top left.
pub struct Image {
    pub width: usize,
    pub height: usize,
    pixels: Vec<[u8; 3]>,
    /// The depth already drawn at each pixel, for hidden-surface
    /// removal. Larger is nearer, so a face behind another is discarded.
    depth: Vec<i64>,
}

const BACKGROUND: [u8; 3] = [18, 20, 26];

/// Full coverage, as an integer fraction.
///
/// Coverage is a numerator over this rather than a float, like every
/// other number in this project: 256 divides evenly into a byte, so
/// blending is a multiply and a shift with nothing rounded twice.
const FULL: i64 = 256;
const NOTHING: i64 = i64::MIN;

impl Image {
    pub fn new(width: usize, height: usize) -> Image {
        Image {
            width,
            height,
            pixels: vec![BACKGROUND; width * height],
            depth: vec![NOTHING; width * height],
        }
    }

    pub fn set(&mut self, x: i64, y: i64, colour: [u8; 3]) {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            return;
        }
        self.pixels[y as usize * self.width + x as usize] = colour;
    }

    /// Draws a pixel only if nothing nearer is already there.
    /// The colour at a pixel, or None outside the image.
    ///
    /// For tests that ask where a stroke actually landed — which is the
    /// only way to check that it is centred on the geometry.
    pub fn at(&self, x: i64, y: i64) -> Option<[u8; 3]> {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            return None;
        }
        Some(self.pixels[y as usize * self.width + x as usize])
    }

    /// Mixes `colour` into a pixel by `coverage`, out of 255, with no
    /// depth test at all.
    ///
    /// For text, which is not geometry: a label sits on top of the
    /// picture, and asking whether it is in front of anything would be
    /// asking a question that has no answer.
    pub fn blend_over(&mut self, x: i64, y: i64, coverage: i64, colour: [u8; 3]) {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            return;
        }
        let coverage = coverage.clamp(0, 255);
        if coverage == 0 {
            return;
        }
        let at = y as usize * self.width + x as usize;
        let behind = self.pixels[at];
        let mix = |ink: u8, under: u8| -> u8 {
            ((ink as i64 * coverage + under as i64 * (255 - coverage)) / 255) as u8
        };
        self.pixels[at] = [
            mix(colour[0], behind[0]),
            mix(colour[1], behind[1]),
            mix(colour[2], behind[2]),
        ];
    }

    /// Mixes `colour` into a pixel by `coverage`, out of `FULL`.
    ///
    /// Blending rather than replacing: a pixel the line only clips has
    /// to come out part background, or the stroke is two pixels wide
    /// wherever it straddles and one where it does not — which is the
    /// wobble the coverage exists to remove.
    fn blend(&mut self, x: i64, y: i64, coverage: i64, depth: i64, colour: [u8; 3]) {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            return;
        }
        let coverage = coverage.clamp(0, FULL);
        if coverage == 0 {
            return;
        }
        let at = y as usize * self.width + x as usize;
        if depth <= self.depth[at] {
            return;
        }
        // The depth is recorded whenever the line covers a pixel more
        // than it leaves uncovered.
        //
        // Half rather than FULL: an anti-aliased stroke rarely covers a
        // pixel completely — a diagonal splits its ink between two — so
        // recording only at FULL left every partial pixel claiming the
        // depth of whatever was behind it.
        //
        // Not at any coverage either. A pixel the line barely clips is
        // mostly the thing behind it, and claiming the near depth there
        // would hide what is still visible through the gap.
        //
        // As it stands this only matters to something drawn AFTER an
        // edge, and edges are drawn last — so nothing observes it
        // today. It is kept because the rule is right for the moment
        // something is.
        if coverage * 2 >= FULL {
            self.depth[at] = depth;
        }
        let behind = self.pixels[at];
        let mix = |ink: u8, under: u8| -> u8 {
            ((ink as i64 * coverage + under as i64 * (FULL - coverage)) / FULL) as u8
        };
        self.pixels[at] = [
            mix(colour[0], behind[0]),
            mix(colour[1], behind[1]),
            mix(colour[2], behind[2]),
        ];
    }

    /// Mixes a face's colour in by how much of the pixel it covers,
    /// if nothing nearer is already there.
    ///
    /// The depth is claimed only when the face covers most of the
    /// pixel. A face that merely clips a pixel leaves most of it
    /// belonging to whatever is behind, and claiming the near depth
    /// there would hide a surface still visible through the gap — the
    /// silhouette would grow by a pixel all the way round.
    fn blend_if_nearer(&mut self, x: i64, y: i64, coverage: i64, depth: i64, colour: [u8; 3]) {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            return;
        }
        let coverage = coverage.clamp(0, FULL);
        if coverage == 0 {
            return;
        }
        let at = y as usize * self.width + x as usize;
        if depth <= self.depth[at] {
            return;
        }
        if coverage * 2 >= FULL {
            self.depth[at] = depth;
        }

        let behind = self.pixels[at];
        let mix = |ink: u8, under: u8| -> u8 {
            ((ink as i64 * coverage + under as i64 * (FULL - coverage)) / FULL) as u8
        };
        self.pixels[at] = [
            mix(colour[0], behind[0]),
            mix(colour[1], behind[1]),
            mix(colour[2], behind[2]),
        ];
    }

    fn set_if_nearer(&mut self, x: i64, y: i64, depth: i64, colour: [u8; 3]) {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            return;
        }
        let at = y as usize * self.width + x as usize;
        if depth <= self.depth[at] {
            return;
        }
        self.depth[at] = depth;
        self.pixels[at] = colour;
    }

    /// Copies another image in at an offset — how the gallery is built.
    pub fn blit(&mut self, other: &Image, left: usize, top: usize) {
        for y in 0..other.height {
            for x in 0..other.width {
                let colour = other.pixels[y * other.width + x];
                self.set((left + x) as i64, (top + y) as i64, colour);
            }
        }
    }

    pub fn fill(&mut self, left: i64, top: i64, width: i64, height: i64, colour: [u8; 3]) {
        for y in top..top + height {
            for x in left..left + width {
                self.set(x, y, colour);
            }
        }
    }
}

// =====================================================================
// the projection
// =====================================================================

/// A point in the kernel's coordinates: whole microns.
#[derive(Clone, Copy)]
pub struct Point3 {
    pub x: i64,
    pub y: i64,
    pub z: i64,
}

/// Where a point lands on screen, and how near it is.
#[derive(Clone, Copy)]
struct Projected {
    x: i64,
    y: i64,
    /// Distance towards the viewer. Larger is nearer.
    depth: i64,
}

/// 2:1 isometric, in integers.
///
/// The y coordinate is doubled before halving so the division is exact —
/// `(x + y) / 2` would throw away a half-pixel and make two points that
/// differ by one micron land on the same pixel in one direction but not
/// the other.
/// Where the camera looks from.
///
/// Named in the TEST rather than chosen here, because it is a question
/// about what is being shown: a draft is 2D, and seeing one in
/// isometric distorts the thing being judged — a square arrives as a
/// rhombus and nothing about it can be read. A solid, having no single
/// plane, wants isometric.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum View {
    /// The 2:1 integer isometric. Right for a solid.
    Isometric,
    /// Straight down one axis, so a plane perpendicular to it appears
    /// at true size and shape.
    Top,
    Bottom,
    Front,
    Back,
    Right,
    Left,
}

impl View {
    /// The view a name means, or None if it names nothing.
    ///
    /// Parsed here rather than in the compiler, so the set of views and
    /// the projections that implement them cannot disagree: adding one
    /// means adding it in both places at once, in this file.
    pub fn named(name: &str) -> Option<View> {
        Some(match name {
            "isometric" => View::Isometric,
            "top" => View::Top,
            "bottom" => View::Bottom,
            "front" => View::Front,
            "back" => View::Back,
            "right" => View::Right,
            "left" => View::Left,
            _ => return None,
        })
    }
}

fn project(point: Point3, scale: i64, view: View) -> Projected {
    // An orthographic view down one axis: the two remaining
    // coordinates are the screen, and the one looked along is the
    // depth. Nothing is foreshortened, which is the point — a square
    // on that plane arrives as a square, at true size.
    //
    // Screen y runs DOWN, so the world axis that runs up is negated.
    // Without it every drawing normal to a plane comes out mirrored,
    // and a profile's winding reads backwards.
    if view != View::Isometric {
        let (x, y, depth) = match view {
            View::Top => (point.x, -point.y, point.z),
            View::Bottom => (point.x, point.y, -point.z),
            View::Front => (point.x, -point.z, -point.y),
            View::Back => (-point.x, -point.z, point.y),
            View::Right => (point.y, -point.z, point.x),
            View::Left => (-point.y, -point.z, -point.x),
            View::Isometric => unreachable!("handled above"),
        };
        return Projected {
            x: x * scale / 1000,
            y: y * scale / 1000,
            depth,
        };
    }

    let x = point.x - point.y;
    let y = (point.x + point.y) - 2 * point.z;
    Projected {
        x: x * scale / 1000,
        // Halved here rather than in the expression above, keeping the
        // arithmetic whole for as long as possible.
        y: y * scale / 2000,
        // Towards the viewer is -x, -y, -z in this projection.
        //
        // The view direction is the vector both screen axes are blind
        // to: sx = x - y kills it when x = y, and sy = (x + y - 2z)/2
        // kills it when x + y = 2z, which together give (1, 1, 1). The
        // camera looks ALONG that from the far corner, so a point with a
        // larger x + y + z is further away, not nearer.
        //
        // Getting this backwards drew the hidden face of a tetrahedron
        // over the three visible ones. A box hid the mistake completely:
        // it is convex and symmetric enough that the wrong face is the
        // right colour in the right place.
        depth: -(point.x + point.y + point.z),
    }
}

// =====================================================================
// triangles
// =====================================================================

/// Twice the signed area of a screen-space triangle.
///
/// The same predicate the kernel uses, on projected coordinates: it says
/// which side of an edge a pixel is on, and its sign says which way the
/// triangle winds.
fn edge(ax: i64, ay: i64, bx: i64, by: i64, px: i64, py: i64) -> i64 {
    (bx - ax) * (py - ay) - (by - ay) * (px - ax)
}

/// Fills a triangle, with depth testing.
///
/// Half-space rasterisation: for each pixel in the bounding box, the
/// three edge functions say whether it is inside. Chosen over scanline
/// conversion because it is the version that is obviously correct — and
/// a renderer whose bugs look like geometry bugs would waste more time
/// than it saves.
fn triangle(
    image: &mut Image,
    a: Projected,
    b: Projected,
    c: Projected,
    colour: [u8; 3],
    // How brightly each corner is lit, in 256ths.
    //
    // Per CORNER rather than per triangle, so the face is shaded
    // ACROSS: a real surface catches more light where it faces the
    // source, and a flat colour is what makes a solid read as a
    // diagram rather than an object.
    corner_light: [i64; 3],
) {
    let area = edge(a.x, a.y, b.x, b.y, c.x, c.y);
    if area == 0 {
        return; // Degenerate on screen: no pixels to fill.
    }
    // Wind consistently, so the inside test has one sign to look for.
    let (b, c) = if area < 0 { (c, b) } else { (b, c) };

    // One pixel wider than the triangle on every side.
    //
    // The pixels a boundary only clips lie OUTSIDE it — that is what
    // makes them partly covered — so a box drawn tight to the corners
    // never visits them and the smoothing would have nothing to work
    // on.
    let left = (a.x.min(b.x).min(c.x) - 1).max(0);
    let right = (a.x.max(b.x).max(c.x) + 1).min(image.width as i64 - 1);
    let top = (a.y.min(b.y).min(c.y) - 1).max(0);
    let bottom = (a.y.max(b.y).max(c.y) + 1).min(image.height as i64 - 1);

    for y in top..=bottom {
        for x in left..=right {
            let first = edge(a.x, a.y, b.x, b.y, x, y);
            let second = edge(b.x, b.y, c.x, c.y, x, y);
            let third = edge(c.x, c.y, a.x, a.y, x, y);
            // How much of this pixel the triangle covers.
            //
            // The half-space test alone is BINARY — inside or outside,
            // nothing between — and a binary test is a staircase
            // wherever the boundary is not axis-aligned. The wire edges
            // were anti-aliased and the faces were not, so a solid came
            // out with clean strokes and jagged fills; on the
            // boundaries no drawn edge covers, the stairs were all
            // there was to see.
            // A plain inside test: the pixel's centre is in the
            // triangle or it is not.
            //
            // No coverage formula any more. Smoothing comes from
            // SAMPLING — the picture is drawn several times larger and
            // averaged down — so a formula here would smooth twice,
            // and it was the formula's thresholds that produced the
            // corner, seam and fold defects in the first place.
            if first < 0 || second < 0 || third < 0 {
                continue;
            }
            let coverage = FULL;
            // Depth INTERPOLATED across the face, by barycentric
            // weights, rather than one value for the whole triangle.
            //
            // Flat depth was the cause of a real bug: a face recorded at
            // the average depth of its corners reads as nearer than it
            // is at its far corner, so the hidden edges there won the
            // depth test and showed through. Interpolating makes a
            // face's depth at a pixel its actual depth, and then an edge
            // needs only the smallest possible bias.
            let total = first + second + third;
            let depth = if total == 0 {
                a.depth
            } else {
                (second * a.depth + third * b.depth + first * c.depth) / total
            };

            // The colour VARIES across the face.
            //
            // A flat face painted one value is what makes a solid read
            // as a diagram: a real surface catches more light where it
            // faces the source and less where it turns away, and even
            // a plane does that because the light is at a finite place
            // rather than infinitely far.
            //
            // Interpolated by the same barycentric weights the depth
            // uses, from a brightness computed at each corner. That is
            // Gouraud shading, and on a flat triangle it costs one
            // multiply per channel per pixel.
            let colour = if total == 0 {
                colour
            } else {
                // The same barycentric weights the depth uses. Gouraud
                // shading: one multiply per channel per pixel.
                let lit = (second * corner_light[0]
                    + third * corner_light[1]
                    + first * corner_light[2])
                    / total;
                [
                    ((colour[0] as i64 * lit) / FULL).clamp(0, 255) as u8,
                    ((colour[1] as i64 * lit) / FULL).clamp(0, 255) as u8,
                    ((colour[2] as i64 * lit) / FULL).clamp(0, 255) as u8,
                ]
            };
            image.blend_if_nearer(x, y, coverage, depth, colour);
        }
    }
}

/// For each triangle, which of its three sides — a-b, b-c, c-a — lie
/// on the shape's boundary rather than being shared with a neighbour.
///
/// A side used by exactly two triangles is interior; anything else is
/// on the outside. That includes a side shared by two triangles that
/// face DIFFERENT ways, such as the fold between two faces of a box:
/// there the surface really does turn, and smoothing it is right.
///
/// The same information `outline` derives for drawing edges, computed
/// separately because it is needed per-triangle-per-side rather than
/// per-edge.
fn boundary_sides(mesh: &Mesh) -> Vec<[bool; 3]> {
    use std::collections::HashMap;

    let mut shared: HashMap<(usize, usize), usize> = HashMap::new();
    for corner in mesh.triangles.chunks_exact(3) {
        for (from, to) in [
            (corner[0], corner[1]),
            (corner[1], corner[2]),
            (corner[2], corner[0]),
        ] {
            let key = if from < to { (from, to) } else { (to, from) };
            *shared.entry(key).or_insert(0) += 1;
        }
    }

    mesh.triangles
        .chunks_exact(3)
        .map(|corner| {
            let mut outer = [true; 3];
            for (side, (from, to)) in [
                (corner[0], corner[1]),
                (corner[1], corner[2]),
                (corner[2], corner[0]),
            ]
            .into_iter()
            .enumerate()
            {
                let key = if from < to { (from, to) } else { (to, from) };
                outer[side] = shared.get(&key).copied().unwrap_or(1) < 2;
            }
            outer
        })
        .collect()
}

/// How much of a pixel a triangle covers, out of `FULL`.
///
/// Each `edge` value is twice the area of the triangle made by the
/// pixel and one side, which is the pixel's distance from that side
/// scaled by the side's length. Dividing by the length gives the
/// distance, and a pixel within half a pixel of a side is covered in
/// proportion to how far in it reaches.
///
/// The NEAREST side decides. At a corner two sides cut the same pixel,
/// and the one cutting away most governs how much is left; taking the
/// minimum is what keeps a corner from coming out brighter than the
/// edges meeting there.
///
/// Approximate rather than exact — true coverage of a square by a
/// half-plane needs an integral — but at this size the difference is
/// invisible, and it is the same integer arithmetic the lines use.
fn coverage_of(
    first: i64,
    second: i64,
    third: i64,
    a: Projected,
    b: Projected,
    c: Projected,
    outer: [bool; 3],
) -> i64 {
    // An interior side contributes nothing to the fade: it is reported
    // as fully inside however near the pixel is, so the neighbouring
    // triangle's own fill meets it exactly.
    let along = |from: Projected, to: Projected, doubled: i64, outer: bool| -> i64 {
        if doubled < 0 {
            // Outside this side, whichever kind it is.
            let length = integer_hypotenuse(to.x - from.x, to.y - from.y).max(1);
            return doubled * FULL / length;
        }
        if !outer {
            return FULL;
        }
        let length = integer_hypotenuse(to.x - from.x, to.y - from.y).max(1);
        doubled * FULL / length
    };

    let nearest = along(a, b, first, outer[0])
        .min(along(b, c, second, outer[1]))
        .min(along(c, a, third, outer[2]));

    // A pixel whose centre is more than half a pixel inside is fully
    // covered; more than half a pixel outside, not at all; between
    // those it takes the share it reaches.
    (nearest + FULL / 2).clamp(0, FULL)
}

/// The length of a vector, in whole pixels, without floating point.
///
/// The kernel avoids roots because geometry must be exact; here the
/// number only scales a coverage that is approximate anyway, so an
/// integer root is enough — and it keeps this file free of floating
/// point like the rest of the project.
fn integer_hypotenuse(run: i64, rise: i64) -> i64 {
    let squared = run * run + rise * rise;
    if squared <= 0 {
        return 0;
    }
    let mut root = squared;
    let mut previous = 0;
    // Newton's method on integers: each step is nearer, and it stops
    // when it stops moving.
    while root != previous {
        previous = root;
        root = (root + squared / root) / 2;
    }
    root
}

/// A line drawn `thickness` samples wide, centred on the path.
///
/// Offset perpendicular to the run rather than by drawing several
/// parallel lines from the endpoints: parallel copies of a diagonal
/// are spaced by whichever axis they were offset along, so the stroke
/// comes out wider along one direction than the other and a box's
/// edges look uneven where they turn.
fn thick_line(
    image: &mut Image,
    a: Projected,
    b: Projected,
    colour: [u8; 3],
    bias: i64,
    thickness: i64,
) {
    if thickness <= 1 {
        line(image, a, b, colour, bias);
        return;
    }

    // Perpendicular to the run, in whole samples. A steep line is
    // widened across x, a shallow one across y — which is the axis the
    // stroke is thin along in each case.
    let steep = (b.y - a.y).abs() > (b.x - a.x).abs();
    let half = thickness / 2;
    for step in -half..=half {
        let (dx, dy) = if steep { (step, 0) } else { (0, step) };
        line(
            image,
            Projected { x: a.x + dx, y: a.y + dy, depth: a.depth },
            Projected { x: b.x + dx, y: b.y + dy, depth: b.depth },
            colour,
            bias,
        );
    }
}

/// Draws a line, for the wireframe over the faces.
/// A line, anti-aliased, for a test that only cares about pixels.
///
/// The same rasteriser the renderer uses, with the depth left flat —
/// so a question about WHERE a stroke lands can be asked without
/// building a projection first.
pub fn line_into(image: &mut Image, from: (i64, i64), to: (i64, i64), colour: [u8; 3]) {
    let a = Projected { x: from.0, y: from.1, depth: 0 };
    let b = Projected { x: to.0, y: to.1, depth: 0 };
    line(image, a, b, colour, 0);
}

/// A line, one pixel wide, CENTRED ON THE PATH IT DRAWS.
///
/// Wu's algorithm, in integers. At each step along the major axis the
/// true position falls between two pixels, and both are drawn — each in
/// proportion to how near it is.
///
/// WHY NOT BRESENHAM
/// -----------------
/// Bresenham picks the NEARER pixel and draws it whole. The stroke then
/// sits up to half a pixel off the true path, alternating sides as it
/// goes, and which side depends on where along the line you look.
///
/// For a solid's edge that is invisible. For a DRAFT it is not: a
/// draft's wire has no physical thickness — it is an imaginary boundary
/// — so the drawn width means nothing and the drawn POSITION means
/// everything. A boundary half a pixel from where the geometry says is
/// a boundary the picture is lying about.
///
/// Splitting the ink between two pixels puts the centre of mass on the
/// path exactly, even though neither pixel is centred on it.
///
/// FRACTIONS ARE INTEGERS
/// ----------------------
/// The position along the minor axis is kept in 256ths, so nothing
/// here is floating point either. `FULL` is 256 because it divides a
/// byte evenly: the blend is a multiply and a shift, rounded once.
fn line(image: &mut Image, a: Projected, b: Projected, colour: [u8; 3], bias: i64) {
    // Drawn from the LOWER end always, so a line and its reverse make
    // the same picture. The geometry does not know which end was
    // written first and neither should the image — and the rounding
    // below is not symmetric, so drawing in written order would make it
    // depend on that.
    let steep = (b.y - a.y).abs() > (b.x - a.x).abs();
    let (a, b) = if steep {
        (
            Projected { x: a.y, y: a.x, depth: a.depth },
            Projected { x: b.y, y: b.x, depth: b.depth },
        )
    } else {
        (a, b)
    };
    let (a, b) = if a.x > b.x { (b, a) } else { (a, b) };

    let span = b.x - a.x;
    if span == 0 {
        // A single point, or a vertical line that became one after the
        // swap. Drawn whole: there is no minor axis to share between.
        let (x, y) = if steep { (a.y, a.x) } else { (a.x, a.y) };
        image.blend(x, y, FULL, a.depth + bias, colour);
        return;
    }

    // How far the minor axis climbs over the whole run, in 256ths of a
    // pixel.
    let rise = (b.y - a.y) * FULL;

    for step in 0..=span {
        let along = a.x + step;

        // The minor coordinate, computed FROM THE STEP rather than
        // accumulated.
        //
        // Accumulating `rise / span` was a real defect. That division
        // is integer, so every step carried the same rounding error,
        // and the same error added repeatedly is a DRIFT rather than a
        // spread: the drawn position slipped behind the true one until
        // it snapped forward a whole pixel, so the stroke stalled for
        // two or three steps and then jumped. Along a long edge that
        // reads as serration.
        //
        // Multiplying first keeps the whole quotient, so the position
        // at a step is exact to a 256th and no error survives into the
        // next one.
        let minor = a.y * FULL + rise * step / span;
        // Rounded toward negative infinity rather than toward zero, so
        // a line above and below the axis are treated alike: integer
        // division in Rust truncates, which would bunch the ink toward
        // y = 0 from both sides.
        let whole = minor.div_euclid(FULL);
        let fraction = minor.rem_euclid(FULL);

        // Interpolated, so a hidden edge does not read as near as its
        // nearer end. Flat-shaded faces record an average depth, so the
        // bias has to exceed how far a face departs from it.
        let depth = a.depth + (b.depth - a.depth) * step / span + bias;

        // The two pixels the true position falls between, each taking
        // the share of the ink that its distance earns. Together they
        // are exactly one pixel's worth, which is what makes the stroke
        // one pixel wide however it is angled.
        if steep {
            image.blend(whole, along, FULL - fraction, depth, colour);
            image.blend(whole + 1, along, fraction, depth, colour);
        } else {
            image.blend(along, whole, FULL - fraction, depth, colour);
            image.blend(along, whole + 1, fraction, depth, colour);
        }
    }
}

// =====================================================================
// a solid
// =====================================================================

/// What a test hands over to be drawn: corners, and triangles indexing
/// them.
pub struct Mesh {
    pub points: Vec<Point3>,
    /// Three indices per triangle for a solid, two per line for a wire.
    pub triangles: Vec<usize>,
    /// Whether these indices are triangles or line segments.
    pub kind: MeshKind,
}

/// What is being drawn.
///
/// A wire exists because a DRAFT has no inside: an open path encloses
/// nothing, so there is nothing to shade. Drawing one as a solid would
/// show an empty tile, which reads as a bug rather than as a profile.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MeshKind {
    Solid,
    Wire,
}

/// The base colour a face is shaded from.
const FACE: [u8; 3] = [96, 146, 226];

/// How brightly a face is lit, from its own orientation.
///
/// Derived from the geometry rather than from the triangle's index. The
/// index version cycled colours every two triangles, which is right for
/// a box — six quads, two triangles each — and wrong for anything else:
/// a tetrahedron's four single-triangle faces came out in two matching
/// pairs, so the solid read as a flat shape.
///
/// Shading from the normal means two triangles of one flat face get the
/// same colour BECAUSE they face the same way, which is the property
/// that was wanted all along, and it holds for any mesh.
/// The outward normal of a triangle, from its model points.
///
/// i64 is enough: coordinates reach 10^7 and this is a product of two,
/// so 10^14.
fn face_normal(a: Point3, b: Point3, c: Point3) -> (i64, i64, i64) {
    let (ux, uy, uz) = (b.x - a.x, b.y - a.y, b.z - a.z);
    let (vx, vy, vz) = (c.x - a.x, c.y - a.y, c.z - a.z);
    (
        uy * vz - uz * vy,
        uz * vx - ux * vz,
        ux * vy - uy * vx,
    )
}

/// The model's bounding box: the two opposite corners.
fn extent(mesh: &Mesh) -> (Point3, Point3) {
    let first = mesh.points.first().copied().unwrap_or(Point3 { x: 0, y: 0, z: 0 });
    let mut low = first;
    let mut high = first;
    for point in &mesh.points {
        low = Point3 { x: low.x.min(point.x), y: low.y.min(point.y), z: low.z.min(point.z) };
        high = Point3 { x: high.x.max(point.x), y: high.y.max(point.y), z: high.z.max(point.z) };
    }
    (low, high)
}

/// How brightly one POINT of a surface is lit, in 256ths.
///
/// A point light rather than a direction. With a light infinitely far
/// away every point of a plane is lit identically, and a flat face
/// comes out one flat colour — which is exactly the diagram look this
/// is meant to replace. A light at a finite place is nearer to one end
/// of a face than the other, and that difference IS the gradient.
///
/// Placed relative to the model's own size, above and to one side, so
/// a box in microns and the same box in millimetres light the same.
fn lighting(at: Point3, normal: (i64, i64, i64), bounds: (Point3, Point3)) -> i64 {
    let (low, high) = bounds;
    let reach = (high.x - low.x).max(high.y - low.y).max(high.z - low.z).max(1);

    // Over the viewer's shoulder, on the SAME side as the camera.
    //
    // The isometric view looks down (1, 1, 1) — the near corner of a
    // box faces (-1, -1, +1) — so the visible faces point toward
    // negative x, negative y and positive z. A light behind the model
    // lights only the three faces the viewer cannot see, and every
    // visible one falls to the ambient floor: a cube came out two flat
    // sides at the same value with no gradient at all.
    //
    // CLOSE on purpose, about one model-width out. At twice the size
    // the falloff across a face spanned six shades of 256 —
    // technically a gradient, and invisible. The nearer the light, the
    // more the angle to it turns between one end of a face and the
    // other, and that turning is the whole effect.
    //
    // Off-centre in x and y rather than symmetric, so the two vertical
    // faces of a box catch DIFFERENT amounts. A symmetric light makes
    // them equal, and two adjacent faces at one value read as a single
    // surface — the form stops being legible.
    // Offset from the model's CENTRE by a direction, rather than by
    // arithmetic on the bounds. The earlier version subtracted half a
    // reach from a centre that was itself half a reach in, so the
    // light landed at y = 0 — exactly in the plane of the front face,
    // whose cosine was then precisely zero and whose brightness fell
    // to the ambient floor. Two faces at 28 and 28.
    let centre = Point3 {
        x: low.x + (high.x - low.x) / 2,
        y: low.y + (high.y - low.y) / 2,
        z: low.z + (high.z - low.z) / 2,
    };
    // Toward the viewer and up.
    //
    // The viewer is at POSITIVE x and y. The projection is
    // `screen_x = x - y`, `screen_y = (x + y) / 2 - z`, with depth
    // `-(x + y + z)` where larger is nearer — so the nearest point is
    // the one with the smallest sum, and the faces a viewer sees are
    // the ones pointing along +x, +y and +z. A light on the negative
    // side lights exactly the three faces that are hidden, and every
    // visible one falls to the ambient floor: two sides at 28 and 28,
    // with a correctly-shaded top.
    //
    // Deliberately NOT symmetric in x and y: a symmetric light gives
    // the two vertical faces of a box the same brightness, and two
    // adjacent faces at one value read as a single surface.
    let light = Point3 {
        x: centre.x + reach * 3 / 2,
        y: centre.y + reach,
        z: centre.z + reach * 2,
    };

    let to_light = ((light.x - at.x) as f64, (light.y - at.y) as f64, (light.z - at.z) as f64);
    let distance = (to_light.0 * to_light.0 + to_light.1 * to_light.1 + to_light.2 * to_light.2).sqrt();
    let length = ((normal.0 as f64).powi(2) + (normal.1 as f64).powi(2) + (normal.2 as f64).powi(2)).sqrt();
    if distance == 0.0 || length == 0.0 {
        return FULL;
    }

    let cosine = ((normal.0 as f64 * to_light.0
        + normal.1 as f64 * to_light.1
        + normal.2 as f64 * to_light.2)
        / (distance * length))
        .clamp(-1.0, 1.0);

    // Ambient plus diffuse.
    //
    // The ambient share is small: with it at half, a face turned away
    // and a face facing the light differed by only a quarter of their
    // brightness, and a cube's three visible sides came out nearly the
    // same shade — the solid read as one flat silhouette rather than
    // three surfaces meeting. Onshape's cube separates them clearly,
    // and the separation is what makes the form legible.
    //
    // Not zero either: a face turned fully away would then be black,
    // and a black face beside a dark background reads as a hole.
    let brightness = 0.30 + 0.85 * cosine.max(0.0);
    (brightness * FULL as f64) as i64
}

#[allow(dead_code)]
fn shade(a: Point3, b: Point3, c: Point3) -> [u8; 3] {
    // The face normal, as a cross product. i64 is enough: coordinates
    // reach 10^7 and this is a product of two, so 10^14.
    let (ux, uy, uz) = (b.x - a.x, b.y - a.y, b.z - a.z);
    let (vx, vy, vz) = (c.x - a.x, c.y - a.y, c.z - a.z);
    let normal = (
        uy * vz - uz * vy,
        uz * vx - ux * vz,
        ux * vy - uy * vx,
    );

    // Lit from over the viewer's shoulder, along the isometric axis, so
    // the three faces of a box meeting at the near corner each catch a
    // different amount.
    let light = (2i64, 3i64, 6i64);
    let dot = normal.0 * light.0 + normal.1 * light.1 + normal.2 * light.2;

    // Normalised by magnitude. Done in floating point ONLY here: this is
    // a pixel colour, not geometry, and nothing decides a shape from it.
    let length = ((normal.0 as f64).powi(2)
        + (normal.1 as f64).powi(2)
        + (normal.2 as f64).powi(2))
    .sqrt();
    let light_length = ((light.0 * light.0 + light.1 * light.1 + light.2 * light.2) as f64).sqrt();
    let cosine = if length == 0.0 {
        0.0
    } else {
        (dot as f64 / (length * light_length)).clamp(-1.0, 1.0)
    };

    // Ambient plus diffuse, so a face turned away is dim rather than
    // black — an unlit face in a wireframe-over-solid reads as a hole.
    let brightness = 0.55 + 0.45 * cosine.max(0.0);
    [
        (FACE[0] as f64 * brightness).min(255.0) as u8,
        (FACE[1] as f64 * brightness).min(255.0) as u8,
        (FACE[2] as f64 * brightness).min(255.0) as u8,
    ]
}

const EDGE_COLOUR: [u8; 3] = [226, 232, 240];

/// A profile's colour. Warmer than a solid's edges, so a draft and a
/// body are not mistaken for each other at a glance in the mosaic.
const WIRE_COLOUR: [u8; 3] = [246, 198, 108];

/// A corner of a profile, marked.
///
/// Points are what a draft IS — the segments between them are derived —
/// so showing them is showing the value rather than a rendering of it.
/// It is also the only way to see a point that two collinear segments
/// pass straight through, which is exactly the kind of thing worth
/// noticing in a profile.
/// A vertex, for a test that only cares about pixels.
pub fn dot_into(image: &mut Image, at: (i64, i64), colour: [u8; 3]) {
    dot(image, Projected { x: at.0, y: at.1, depth: i64::MAX }, VERTEX_RADIUS, colour);
}

/// A vertex of a given radius, in quarter-pixels.
pub fn dot_sized(image: &mut Image, at: (i64, i64), radius: i64, colour: [u8; 3]) {
    dot(image, Projected { x: at.0, y: at.1, depth: i64::MAX }, radius, colour);
}

/// How big a vertex is, in quarter-pixels, at the standard tile size.
///
/// Scaled with the tile rather than fixed: at 320 pixels across a
/// two-and-a-half-pixel disc reads as a square — there are not enough
/// pixels for its rim to fall anywhere but the corners — and at 2560 it
/// is a speck. The mark should look the same whatever the tile is.
pub const VERTEX_RADIUS: i64 = 5;

/// A vertex: a small anti-aliased DISC.
///
/// Round rather than square, the way Onshape draws one. A square has
/// corners, and corners read as direction — a point has none. It is
/// also visibly bigger along its diagonal than across its face, so a
/// row of vertices appears to change size as the path turns.
///
/// Coverage from the distance to the centre, in the same integer
/// fractions the lines use. A pixel whose centre is inside the radius
/// is full; one straddling the rim takes the share its distance earns.
fn dot(image: &mut Image, at: Projected, radius: i64, colour: [u8; 3]) {
    // In quarter-pixels, so the rim falls between whole pixels and the
    // disc is not a plus sign.
    let radius = radius.max(2);
    const SCALE: i64 = 4;

    let reach = (radius / SCALE) + 1;
    for dy in -reach..=reach {
        for dx in -reach..=reach {
            // The distance from the pixel's CENTRE to the dot's, in
            // quarter-pixels. Squared, so nothing is rooted.
            let far = (dx * SCALE) * (dx * SCALE) + (dy * SCALE) * (dy * SCALE);
            let inner = (radius - SCALE / 2) * (radius - SCALE / 2);
            let outer = (radius + SCALE / 2) * (radius + SCALE / 2);

            let coverage = if far <= inner {
                FULL
            } else if far >= outer {
                0
            } else {
                // Across the rim, linearly in the squared distance.
                // Not exact coverage of a circle by a square — that
                // needs an integral — but smooth, symmetric, and
                // indistinguishable at this size.
                FULL * (outer - far) / (outer - inner)
            };

            image.blend(at.x + dx, at.y + dy, coverage, at.depth, colour);
        }
    }
}

/// Renders a mesh, centred and scaled to fit.
/// How many times larger the picture is drawn before being reduced.
///
/// Three, so every pixel of the result averages nine samples.
///
/// SUPERSAMPLING rather than a coverage formula. A formula has to
/// approximate how much of a pixel a shape covers — distance to the
/// nearest edge, a threshold at a half — and every threshold has a
/// case it gets wrong. Three separate ones were tuned and retuned
/// here: a corner came out brighter than the edges meeting it, a
/// triangulation seam showed through a flat face, a fold beaded where
/// the depth rounded against the stroke.
///
/// Sampling has no threshold. A boundary pixel gets exactly the
/// fraction of samples that landed inside, corners and seams and folds
/// alike, because there is no special case to get wrong — the geometry
/// answers the question directly.
///
/// Three rather than two because a 2:1 isometric edge advances two
/// pixels per row, so two samples across leaves the same steps; and
/// rather than four because nine samples already put the error below
/// what a byte of colour can show, and the cost is quadratic.
const SUPERSAMPLE: usize = 3;

/// Renders a mesh, centred and scaled to fit.
///
/// Drawn large and reduced, which is where the smoothing comes from.
pub fn render(mesh: &Mesh, width: usize, height: usize, view: View) -> Image {
    let large = render_flat(
        mesh,
        width * SUPERSAMPLE,
        height * SUPERSAMPLE,
        view,
    );
    reduce(&large, SUPERSAMPLE)
}

/// Averages a block of samples down to one pixel each.
fn reduce(large: &Image, by: usize) -> Image {
    let mut small = Image::new(large.width / by, large.height / by);
    for y in 0..small.height {
        for x in 0..small.width {
            let mut total = [0u32; 3];
            for dy in 0..by {
                for dx in 0..by {
                    let sample = large
                        .at((x * by + dx) as i64, (y * by + dy) as i64)
                        .unwrap_or(BACKGROUND);
                    for channel in 0..3 {
                        total[channel] += sample[channel] as u32;
                    }
                }
            }
            let samples = (by * by) as u32;
            small.set(
                x as i64,
                y as i64,
                [
                    (total[0] / samples) as u8,
                    (total[1] / samples) as u8,
                    (total[2] / samples) as u8,
                ],
            );
        }
    }
    small
}

fn render_flat(mesh: &Mesh, width: usize, height: usize, view: View) -> Image {
    // Everything drawn scales with the tile: a mark sized for 320
    // pixels is a speck at 2560, and one sized for 2560 is a blob at
    // 320. Taken from the width, against the size these numbers were
    // chosen at.
    let detail = (width.max(1) as i64 * 4 / 320).max(4);
    let mut image = Image::new(width, height);
    let least = match mesh.kind {
        MeshKind::Solid => 3,
        MeshKind::Wire => 2,
    };
    if mesh.points.is_empty() || mesh.triangles.len() < least {
        return image;
    }

    // Scale so the projected shape fills most of the frame, whatever
    // size the model happens to be — a box in microns and the same box
    // in millimetres should look identical.
    let scale = fit(mesh, width, height, view);
    let projected: Vec<Projected> = mesh.points.iter().map(|p| project(*p, scale, view)).collect();

    let (offset_x, offset_y) = centre(&projected, width, height);
    let placed: Vec<Projected> = projected
        .iter()
        .map(|p| Projected {
            x: p.x + offset_x,
            y: p.y + offset_y,
            depth: p.depth,
        })
        .collect();

    // A wire is the path and nothing else: no fill, no culling, no
    // depth. Every segment is drawn, because a profile has no front and
    // no back — it is a line in space, and hiding half of it would hide
    // exactly the half a user is checking.
    if mesh.kind == MeshKind::Wire {
        // Thick in SAMPLES, so the stroke survives the reduction: a
        // line one sample wide averages to a ninth of a pixel of ink
        // and all but vanishes.
        for segment in mesh.triangles.chunks_exact(2) {
            thick_line(
                &mut image,
                placed[segment[0]],
                placed[segment[1]],
                WIRE_COLOUR,
                0,
                SUPERSAMPLE as i64,
            );
        }
        // The vertices, after the segments and in front of them.
        //
        // A point of a draft sits exactly ON the lines that meet there,
        // so at the same depth — and a depth test written `<=` rejects
        // it. In isometric that went unnoticed because the two rarely
        // round the same; drawn normal to the plane they always do, and
        // every dot vanished.
        //
        // Drawn at the nearest depth there is rather than at the
        // point's own: a vertex is a marker, not geometry, and the
        // thing it marks is right there behind it.
        for point in &placed {
            dot(
                &mut image,
                Projected { x: point.x, y: point.y, depth: i64::MAX },
                VERTEX_RADIUS * detail / 4,
                WIRE_COLOUR,
            );
        }
        return image;
    }

    // Where the model is, so the light can be placed relative to it
    // rather than at a fixed point that falls inside a large solid and
    // outside a small one.
    let bounds = extent(mesh);

    for (index, corner) in mesh.triangles.chunks_exact(3).enumerate() {
        let (a, b, c) = (
            placed[corner[0]],
            placed[corner[1]],
            placed[corner[2]],
        );

        // Back faces are not drawn at all.
        //
        // The kernel guarantees every triangle winds counter-clockwise
        // seen from outside — there is a test for exactly that — so a
        // triangle that winds the other way on screen is one the viewer
        // is behind, and drawing it puts the inside of the solid over
        // the outside.
        //
        // The depth test alone is not enough. It resolves which surface
        // is nearer, but a back face and the front face in front of it
        // can round to the same depth at a shared edge, and then the
        // back one wins on some pixels. Culling removes the question.
        if !faces_viewer(a, b, c) {
            continue;
        }

        // Shaded from the MODEL points, not the projected ones: the
        // projection flattens one axis away, and a normal taken from it
        // would light two differently-facing surfaces the same.
        let normal = face_normal(
            mesh.points[corner[0]],
            mesh.points[corner[1]],
            mesh.points[corner[2]],
        );
        let colour = FACE;
        // How brightly each corner of this triangle is lit.
        //
        // From the corner's POSITION, not just the face's direction: a
        // point light is nearer to one end of a face than the other,
        // and that difference is the gradient across it.
        let corner_light = [
            lighting(mesh.points[corner[0]], normal, bounds),
            lighting(mesh.points[corner[1]], normal, bounds),
            lighting(mesh.points[corner[2]], normal, bounds),
        ];
        triangle(&mut image, a, b, c, colour, corner_light);
    }

    // The smallest bias that works, now that face depth is exact at
    // every pixel: enough to sit on top of its own face, not enough to
    // punch through a face in front.
    // Enough that an edge wins against the face it bounds at every
    // pixel along it, not just at some.
    //
    // One used to be enough because Bresenham drew one whole pixel per
    // column, at a depth interpolated between the same two endpoints
    // the face's own corners gave. Anti-aliasing splits the stroke
    // across two pixels and rounds the interpolation differently at
    // each, so a bias of one loses on about half of them — and the
    // edge came out drawn on every OTHER column.
    //
    // Sized against the depth SPREAD of a face rather than picked: a
    // face is recorded at one depth per pixel, and the stroke has to
    // clear the largest step that interpolation can put between two
    // adjacent pixels of it.
    let bias = depth_step(&placed).max(1);

    // Only the edges a person would draw.
    //
    // A box has twelve edges, not thirty-six. Every triangle edge would
    // include the diagonal that splits each quad face — real geometry,
    // but an artefact of triangulation rather than a feature of the
    // solid, and drawing it makes a box look like a tent.
    //
    // The rule: an edge shared by two triangles that face the same way
    // is interior. It is the same information a renderer uses for
    // crease detection, and here it needs no angles — two triangles of
    // one flat face have the same screen-space normal, so comparing
    // their winding and plane is enough.
    // Drawn THICK, in supersample pixels.
    //
    // The picture is reduced by `SUPERSAMPLE` afterwards, so a stroke
    // one sample wide becomes a ninth of a pixel of ink and all but
    // vanishes — the edges faded to a spike of 115 against a face of
    // 96, where the colour asked for is 226. To come out one pixel
    // wide in the result, an edge has to be `SUPERSAMPLE` samples wide
    // here.
    let thickness = SUPERSAMPLE as i64;
    for (a, b) in outline(mesh, &placed) {
        thick_line(&mut image, placed[a], placed[b], EDGE_COLOUR, bias, thickness);
    }
    let _ = &FACE;

    image
}

/// Whether a triangle is one the viewer can see the outside of.
///
/// Measured rather than reasoned about: the top face of a box, which is
/// the one plainly visible from above in isometric, projects with a
/// POSITIVE signed area, and the bottom face with a negative one. Two
/// sign conventions compose here — the model's outward winding and a
/// screen y that grows downward — and deriving the result from first
/// principles got it backwards once already.
fn faces_viewer(a: Projected, b: Projected, c: Projected) -> bool {
    edge(a.x, a.y, b.x, b.y, c.x, c.y) > 0
}

/// The edges worth drawing: those NOT shared by two coplanar triangles.
///
/// An edge between two triangles of the same flat face is the diagonal
/// left over from triangulation. It is not part of the shape, and
/// drawing it turns a box into a tent.
fn outline(mesh: &Mesh, placed: &[Projected]) -> Vec<(usize, usize)> {
    use std::collections::HashMap;

    // Which triangles the viewer can see the outside of. An edge whose
    // faces are ALL turned away is on the far side of the solid, and
    // drawing it puts the back edges of a box through its front.
    //
    // The depth test cannot be relied on for this: an edge is biased
    // forward so it is not swallowed by its own face, and that same bias
    // is what lets a hidden edge win against a face in front of it.
    let visible: Vec<bool> = mesh
        .triangles
        .chunks_exact(3)
        .map(|corner| faces_viewer(placed[corner[0]], placed[corner[1]], placed[corner[2]]))
        .collect();

    // Each undirected edge, with the triangles that use it.
    let mut shared: HashMap<(usize, usize), Vec<usize>> = HashMap::new();
    for (index, corner) in mesh.triangles.chunks_exact(3).enumerate() {
        for (from, to) in [
            (corner[0], corner[1]),
            (corner[1], corner[2]),
            (corner[2], corner[0]),
        ] {
            let key = if from < to { (from, to) } else { (to, from) };
            shared.entry(key).or_default().push(index);
        }
    }

    let mut edges: Vec<(usize, usize)> = shared
        .iter()
        .filter(|(_, triangles)| {
            // Hidden: every face using it is turned away.
            if !triangles.iter().any(|index| visible[*index]) {
                return false;
            }
            // Kept unless exactly two triangles share it AND they lie in
            // the same plane.
            if triangles.len() != 2 {
                return true;
            }
            !coplanar(mesh, placed, triangles[0], triangles[1])
        })
        .map(|(edge, _)| *edge)
        .collect();
    // Sorted so the picture is byte-identical between runs — a HashMap
    // iterates in whatever order it likes, and an image that differs run
    // to run cannot be compared against a golden one.
    edges.sort_unstable();
    edges
}

/// How far apart in depth two adjacent pixels of one face can be.
///
/// The bias an edge needs, derived rather than guessed: an edge is
/// drawn over the face it bounds, and it has to win the depth test at
/// EVERY pixel along it — including the ones where interpolation
/// rounds the face nearer than the stroke.
///
/// Taken from the depth range of the whole projection divided by its
/// pixel span, which is the most one step can change. Generous by a
/// little, which is the right side to err on: too small dots the edge,
/// too large only lets an edge show through a face it is very slightly
/// behind.
fn depth_step(placed: &[Projected]) -> i64 {
    let Some(first) = placed.first() else {
        return 1;
    };
    let mut near = first.depth;
    let mut far = first.depth;
    let mut left = first.x;
    let mut right = first.x;
    let mut top = first.y;
    let mut bottom = first.y;
    for point in placed {
        near = near.max(point.depth);
        far = far.min(point.depth);
        left = left.min(point.x);
        right = right.max(point.x);
        top = top.min(point.y);
        bottom = bottom.max(point.y);
    }
    let span = (right - left).max(bottom - top).max(1);

    // Eight steps, not two.
    //
    // One step is what the depth changes between two ADJACENT pixels
    // of a face, and two was chosen as a margin on that. But an edge
    // and the face it bounds are not sampled at the same points: the
    // stroke's dim half sits up to a pixel to the side of the bright
    // one, and the face's depth there is interpolated from different
    // barycentric weights. Two steps was not enough to cover that, so
    // the dim pixel lost the comparison on about two rows in five and
    // the fold came out as a bead rather than a line.
    //
    // Measured on a box: at two, one fold held `226, 145` on some rows
    // and a bare `226` on the rest; at eight, every row holds
    // `157, 226, 145`.
    //
    // Erring large is the right side. Too small dots the edge, which
    // is a visible defect on every picture; too large only lets an
    // edge show through a face it is very slightly behind, which needs
    // two surfaces within eight depth steps to appear at all.
    ((near - far) / span).max(1) * 8
}

/// Whether two triangles of a mesh lie in the same plane.
fn coplanar(mesh: &Mesh, placed: &[Projected], first: usize, second: usize) -> bool {
    let _ = placed;
    let a = &mesh.triangles[first * 3..first * 3 + 3];
    let b = &mesh.triangles[second * 3..second * 3 + 3];

    // orient3d of the second triangle's points against the first's
    // plane: zero for all three means one plane. The same predicate the
    // kernel uses, on the same integers.
    b.iter().all(|point| {
        determinant(
            mesh.points[a[0]],
            mesh.points[a[1]],
            mesh.points[a[2]],
            mesh.points[*point],
        ) == 0
    })
}

/// orient3d, in i128 — the determinant reaches 10^21 at full range.
fn determinant(a: Point3, b: Point3, c: Point3, d: Point3) -> i128 {
    let (bx, by, bz) = ((b.x - a.x) as i128, (b.y - a.y) as i128, (b.z - a.z) as i128);
    let (cx, cy, cz) = ((c.x - a.x) as i128, (c.y - a.y) as i128, (c.z - a.z) as i128);
    let (dx, dy, dz) = ((d.x - a.x) as i128, (d.y - a.y) as i128, (d.z - a.z) as i128);
    bx * (cy * dz - cz * dy) - by * (cx * dz - cz * dx) + bz * (cx * dy - cy * dx)
}

/// A scale that makes the projected model fill the frame.
fn fit(mesh: &Mesh, width: usize, height: usize, view: View) -> i64 {
    let unscaled: Vec<Projected> = mesh.points.iter().map(|p| project(*p, 1000, view)).collect();
    let span_x = span(unscaled.iter().map(|p| p.x)).max(1);
    let span_y = span(unscaled.iter().map(|p| p.y)).max(1);

    // 80% of the frame, so nothing touches the border.
    let by_width = (width as i64 * 800) / span_x;
    let by_height = (height as i64 * 800) / span_y;
    by_width.min(by_height).max(1)
}

fn span(values: impl Iterator<Item = i64>) -> i64 {
    let mut low = i64::MAX;
    let mut high = i64::MIN;
    for value in values {
        low = low.min(value);
        high = high.max(value);
    }
    if low > high {
        return 0;
    }
    high - low
}

fn centre(points: &[Projected], width: usize, height: usize) -> (i64, i64) {
    let low_x = points.iter().map(|p| p.x).min().unwrap_or(0);
    let high_x = points.iter().map(|p| p.x).max().unwrap_or(0);
    let low_y = points.iter().map(|p| p.y).min().unwrap_or(0);
    let high_y = points.iter().map(|p| p.y).max().unwrap_or(0);
    (
        width as i64 / 2 - (low_x + high_x) / 2,
        height as i64 / 2 - (low_y + high_y) / 2,
    )
}

// =====================================================================
// text
// =====================================================================
// PNG
// =====================================================================

/// Writes a PNG. Uncompressed deflate blocks, so there is no dependency
/// on a compression library — the images are small and written once.
pub fn write_png(image: &Image, path: &Path) -> Result<(), String> {
    let png = encode_png(image);
    std::fs::write(path, png).map_err(|error| format!("cannot write {}: {error}", path.display()))
}

/// A PNG, as bytes.
///
/// Separate from writing it, so what the encoder produces can be asked
/// about without a filesystem — the size of the result is a property
/// worth testing, and these images go into git.
pub fn encode_png(image: &Image) -> Vec<u8> {
    // Filtered per row, with the filter each row is smallest under.
    //
    // PNG's filters subtract a neighbour from each byte, and a picture
    // that is mostly flat colour on a flat background becomes mostly
    // ZEROS — which then compresses to almost nothing. Writing the raw
    // bytes instead left a 2560-pixel mosaic at twelve megabytes.
    let stride = image.width * 3;
    let mut raw = Vec::with_capacity(image.height * (1 + stride));
    let mut previous = vec![0u8; stride];
    let mut row = vec![0u8; stride];

    for y in 0..image.height {
        for x in 0..image.width {
            let pixel = image.pixels[y * image.width + x];
            row[x * 3..x * 3 + 3].copy_from_slice(&pixel);
        }

        // `Up` — this row minus the one above — is the right filter for
        // a picture with horizontal runs, which every one of these is:
        // a background, a face, a label bar. `Sub` and `None` are
        // tried too, and the smallest sum of absolute values wins,
        // which is the standard heuristic.
        let (filter, filtered) = best_filter(&row, &previous);
        raw.push(filter);
        raw.extend_from_slice(&filtered);
        previous.copy_from_slice(&row);
    }

    let mut png = Vec::new();
    png.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);

    let mut header = Vec::new();
    header.extend_from_slice(&(image.width as u32).to_be_bytes());
    header.extend_from_slice(&(image.height as u32).to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]); // 8-bit, truecolour
    chunk(&mut png, b"IHDR", &header);
    chunk(&mut png, b"IDAT", &zlib(&raw));
    chunk(&mut png, b"IEND", &[]);
    png
}

/// Which of PNG's filters makes this row smallest.
///
/// The sum of absolute differences, treating each byte as signed —
/// the heuristic the PNG specification itself recommends. A row of one
/// colour filters to all zeros under `Sub`; a row identical to the one
/// above filters to all zeros under `Up`.
fn best_filter(row: &[u8], previous: &[u8]) -> (u8, Vec<u8>) {
    let none = row.to_vec();
    let sub: Vec<u8> = row
        .iter()
        .enumerate()
        .map(|(at, byte)| byte.wrapping_sub(if at >= 3 { row[at - 3] } else { 0 }))
        .collect();
    let up: Vec<u8> = row
        .iter()
        .zip(previous)
        .map(|(byte, above)| byte.wrapping_sub(*above))
        .collect();

    let cost = |bytes: &[u8]| -> u64 {
        bytes.iter().map(|byte| (*byte as i8).unsigned_abs() as u64).sum()
    };

    let mut best = (0u8, none);
    for (filter, candidate) in [(1u8, sub), (2u8, up)] {
        if cost(&candidate) < cost(&best.1) {
            best = (filter, candidate);
        }
    }
    best
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = kind.to_vec();
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// A zlib stream, deflated with fixed Huffman codes and run-length
/// matching.
///
/// Written here rather than taken from a crate, for the same reason
/// everything else is: one fewer dependency to pin, and the format is
/// small enough to be read in one sitting.
///
/// Fixed Huffman rather than dynamic. Dynamic codes save perhaps a
/// fifth more on these images and cost a code-length table, a second
/// pass and a good deal of code to get wrong. What actually matters is
/// the MATCHING — a filtered row of flat colour is a run of zeros, and
/// a run is what turns twelve megabytes into a hundred kilobytes.
fn zlib(data: &[u8]) -> Vec<u8> {
    let mut bits = BitWriter::new();
    // Deflate, 32K window, no preset dictionary.
    bits.bytes.push(0x78);
    bits.bytes.push(0x01);

    // One fixed-Huffman block, marked final.
    bits.write(1, 1);
    bits.write(1, 2);

    let mut at = 0usize;
    while at < data.len() {
        // The longest run of the byte at `at`, up to what one length
        // code can carry.
        let mut run = 1usize;
        while at + run < data.len() && data[at + run] == data[at] && run < 258 {
            run += 1;
        }

        // A match needs a distance, and the nearest identical byte is
        // one back — so a run of N is one literal and a match of N-1
        // at distance 1. Worth it from four bytes up; below that the
        // literals are shorter than the match.
        if run >= 4 {
            fixed_literal(&mut bits, data[at]);
            emit_match(&mut bits, run - 1, 1);
            at += run;
            continue;
        }

        fixed_literal(&mut bits, data[at]);
        at += 1;
    }

    // End of block.
    fixed_literal_code(&mut bits, 256);
    bits.flush();

    bits.bytes.extend_from_slice(&adler32(data).to_be_bytes());
    bits.bytes
}

/// Deflate's bit order: least-significant first within a byte, but
/// Huffman codes written most-significant first.
struct BitWriter {
    bytes: Vec<u8>,
    partial: u32,
    filled: u32,
}

impl BitWriter {
    fn new() -> BitWriter {
        BitWriter { bytes: Vec::new(), partial: 0, filled: 0 }
    }

    /// `count` bits of `value`, least-significant first.
    fn write(&mut self, value: u32, count: u32) {
        self.partial |= value << self.filled;
        self.filled += count;
        while self.filled >= 8 {
            self.bytes.push((self.partial & 0xff) as u8);
            self.partial >>= 8;
            self.filled -= 8;
        }
    }

    /// A Huffman code: most-significant bit first, which is the one
    /// place deflate reverses itself.
    fn write_code(&mut self, code: u32, count: u32) {
        for shift in (0..count).rev() {
            self.write((code >> shift) & 1, 1);
        }
    }

    fn flush(&mut self) {
        if self.filled > 0 {
            self.bytes.push((self.partial & 0xff) as u8);
            self.partial = 0;
            self.filled = 0;
        }
    }
}

/// A literal byte, in the fixed Huffman code.
fn fixed_literal(bits: &mut BitWriter, byte: u8) {
    fixed_literal_code(bits, byte as u32);
}

/// One symbol of the fixed literal/length alphabet.
///
/// The code lengths are fixed by the specification:
///
/// ```text
/// 0..=143    8 bits, 0x30 + symbol
/// 144..=255  9 bits, 0x190 + symbol - 144
/// 256..=279  7 bits, symbol - 256
/// 280..=287  8 bits, 0xc0 + symbol - 280
/// ```
fn fixed_literal_code(bits: &mut BitWriter, symbol: u32) {
    match symbol {
        0..=143 => bits.write_code(0x30 + symbol, 8),
        144..=255 => bits.write_code(0x190 + symbol - 144, 9),
        256..=279 => bits.write_code(symbol - 256, 7),
        _ => bits.write_code(0xc0 + symbol - 280, 8),
    }
}

/// A match: how many bytes, and how far back.
fn emit_match(bits: &mut BitWriter, length: usize, distance: usize) {
    let (code, extra_bits, base) = length_code(length);
    fixed_literal_code(bits, code);
    if extra_bits > 0 {
        bits.write((length - base) as u32, extra_bits);
    }
    // The distance alphabet is five fixed bits. Distance 1 is code 0,
    // and it is the only distance this uses.
    let _ = distance;
    bits.write_code(0, 5);
}

/// Deflate's length alphabet: the symbol, its extra bits, and the
/// smallest length it covers.
fn length_code(length: usize) -> (u32, u32, usize) {
    match length {
        3..=10 => (257 + (length - 3) as u32, 0, length),
        11..=18 => (265 + ((length - 11) / 2) as u32, 1, 11 + (length - 11) / 2 * 2),
        19..=34 => (269 + ((length - 19) / 4) as u32, 2, 19 + (length - 19) / 4 * 4),
        35..=66 => (273 + ((length - 35) / 8) as u32, 3, 35 + (length - 35) / 8 * 8),
        67..=130 => (277 + ((length - 67) / 16) as u32, 4, 67 + (length - 67) / 16 * 16),
        131..=257 => (281 + ((length - 131) / 32) as u32, 5, 131 + (length - 131) / 32 * 32),
        _ => (285, 0, 258),
    }
}

fn adler32(data: &[u8]) -> u32 {
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for byte in data {
        a = (a + *byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}
