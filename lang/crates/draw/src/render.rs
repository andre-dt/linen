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
        // Not only at FULL. An anti-aliased stroke rarely covers a
        // pixel completely — a diagonal splits its ink between two —
        // so recording only at FULL left every partial pixel claiming
        // the depth of whatever was behind it. The next face drawn
        // over that pixel won, and the edge came out drawn on every
        // OTHER column: dotted.
        //
        // Not at any coverage either. A pixel the line barely clips is
        // mostly the thing behind it, and claiming the near depth there
        // would hide what is still visible through the gap.
        //
        // Half is the line between those: the pixel belongs to whatever
        // covers most of it.
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
fn triangle(image: &mut Image, a: Projected, b: Projected, c: Projected, colour: [u8; 3]) {
    let area = edge(a.x, a.y, b.x, b.y, c.x, c.y);
    if area == 0 {
        return; // Degenerate on screen: no pixels to fill.
    }
    // Wind consistently, so the inside test has one sign to look for.
    let (b, c) = if area < 0 { (c, b) } else { (b, c) };

    let left = a.x.min(b.x).min(c.x).max(0);
    let right = a.x.max(b.x).max(c.x).min(image.width as i64 - 1);
    let top = a.y.min(b.y).min(c.y).max(0);
    let bottom = a.y.max(b.y).max(c.y).min(image.height as i64 - 1);

    for y in top..=bottom {
        for x in left..=right {
            let first = edge(a.x, a.y, b.x, b.y, x, y);
            let second = edge(b.x, b.y, c.x, c.y, x, y);
            let third = edge(c.x, c.y, a.x, a.y, x, y);
            if first < 0 || second < 0 || third < 0 {
                continue;
            }
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
            image.set_if_nearer(x, y, depth, colour);
        }
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

    // The minor coordinate, in 256ths of a pixel, and how much it
    // advances per step.
    let rise = (b.y - a.y) * FULL;
    let mut minor = a.y * FULL;

    for step in 0..=span {
        let along = a.x + step;
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

        minor += rise / span;
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
pub fn render(mesh: &Mesh, width: usize, height: usize, view: View) -> Image {
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
        for segment in mesh.triangles.chunks_exact(2) {
            line(&mut image, placed[segment[0]], placed[segment[1]], WIRE_COLOUR, 0);
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

    for corner in mesh.triangles.chunks_exact(3) {
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
        let colour = shade(
            mesh.points[corner[0]],
            mesh.points[corner[1]],
            mesh.points[corner[2]],
        );
        triangle(&mut image, a, b, c, colour);
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
    for (a, b) in outline(mesh, &placed) {
        line(&mut image, placed[a], placed[b], EDGE_COLOUR, bias);
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
    ((near - far) / span).max(1) * 2
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
