// =====================================================================
// THE PICTURES LOOK LIKE A CAD SYSTEM'S.
//
// The renderer began as a diagram: flat colours, whole-pixel edges,
// enough to tell a wrong solid from a right one. These are the tests
// for the properties that make it read as a rendering instead —
// gradients across a face, edges smoothed by sampling rather than by a
// coverage formula, a highlight where the light catches.
//
// WHY EACH IS MEASURABLE
// ----------------------
// "Looks better" is not a test. Each property below is stated as
// something countable in the pixels: how many distinct shades a face
// holds, how far a boundary's ink is spread, whether the brightest
// pixel of a lit face is where the light points.
// =====================================================================

use draw::render::{render, Mesh, MeshKind, Point3, View};

/// A cube, wound counter-clockwise seen from outside.
fn cube(size: i64) -> Mesh {
    let point = |x: i64, y: i64, z: i64| Point3 { x, y, z };
    let points = vec![
        point(0, 0, 0),
        point(size, 0, 0),
        point(size, size, 0),
        point(0, size, 0),
        point(0, 0, size),
        point(size, 0, size),
        point(size, size, size),
        point(0, size, size),
    ];
    let mut triangles = Vec::new();
    for quad in [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [1, 2, 6, 5],
        [2, 3, 7, 6],
        [3, 0, 4, 7],
    ] {
        triangles.extend_from_slice(&[quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]]);
    }
    Mesh { points, triangles, kind: MeshKind::Solid }
}

/// Every distinct red value in an image, with how many pixels hold it.
fn shades(image: &draw::render::Image) -> std::collections::BTreeMap<u8, usize> {
    let mut counts = std::collections::BTreeMap::new();
    for y in 0..image.height as i64 {
        for x in 0..image.width as i64 {
            if let Some(colour) = image.at(x, y) {
                *counts.entry(colour[0]).or_insert(0) += 1;
            }
        }
    }
    counts
}

// A FACE IS SHADED ACROSS, NOT PAINTED FLAT.
//
// Onshape's cube fades from light at one edge of a face to dark at the
// other. Ours painted every triangle of a face ONE value, which is
// what makes a solid read as a diagram rather than an object — the
// single biggest difference between the two pictures.
//
// Counted rather than eyeballed: a flat face contributes one shade
// however many pixels it has, so a cube's three visible faces give
// three. A gradient gives a spread.
#[test]
fn a_face_holds_a_gradient_of_shades() {
    let image = render(&cube(1000), 300, 300, View::Isometric);
    let counts = shades(&image);

    // Shades held by enough pixels to be a face rather than an edge or
    // a boundary pixel.
    let broad: Vec<u8> = counts
        .iter()
        .filter(|(_, held)| **held > 150)
        .map(|(shade, _)| *shade)
        .collect();

    assert!(
        broad.len() >= 12,
        "the solid uses only {} broad shades ({broad:?}) — its faces are \
         painted flat rather than shaded across",
        broad.len()
    );
}

// THE THREE VISIBLE FACES OF A BOX ARE TOLD APART.
//
// A cube in isometric shows three faces meeting at the near corner.
// If two of them come out the same shade they read as ONE surface,
// and the form stops being legible — the solid becomes a flat
// hexagonal silhouette with a line across it.
//
// It happened twice while building this. First with the ambient share
// at half, which left only a quarter of the brightness range for the
// angle to work in. Then with the light placed BEHIND the model: the
// isometric camera looks down (1, 1, 1), so a light on the far side
// lights exactly the three faces the viewer cannot see and every
// visible one falls to the ambient floor — two sides at 28 and 28.
#[test]
fn a_boxs_faces_are_distinguishable() {
    let image = render(&cube(1000), 300, 300, View::Isometric);

    // The middle of each visible face, as fractions of the tile: the
    // top face above the near corner, the two sides below it.
    let sample = |fx: f64, fy: f64| -> i64 {
        let x = (image.width as f64 * fx) as i64;
        let y = (image.height as f64 * fy) as i64;
        image.at(x, y).map(|c| c[0] as i64).unwrap_or(0)
    };
    let top = sample(0.50, 0.32);
    let left = sample(0.35, 0.62);
    let right = sample(0.65, 0.62);

    // Each pair has to differ by more than a rounding wobble.
    let apart = |a: i64, b: i64| (a - b).abs();
    assert!(
        apart(top, left) >= 12 && apart(top, right) >= 12 && apart(left, right) >= 12,
        "the three faces read {top}, {left}, {right} — two of them are the \
         same surface as far as a viewer can tell"
    );
}

// THE EDGES SURVIVE THE REDUCTION.
//
// A stroke drawn one SAMPLE wide becomes a ninth of a pixel of ink
// once the picture is averaged down, and all but vanishes: the folds
// of a cube faded to a spike of 115 against a face of 96, where the
// colour asked for is 226. The solid lost its outlines and read as
// three gradients meeting.
//
// To come out one pixel wide in the result, an edge has to be drawn
// `SUPERSAMPLE` samples wide before the reduction.
#[test]
fn an_edge_is_brighter_than_the_faces_it_divides() {
    let image = render(&cube(1000), 300, 300, View::Isometric);

    let brightest = (0..image.height as i64)
        .flat_map(|y| (0..image.width as i64).map(move |x| (x, y)))
        .filter_map(|(x, y)| image.at(x, y))
        .map(|colour| colour[0] as i64)
        .max()
        .unwrap_or(0);

    // The lit face is around 150; an edge is 226. Halfway between says
    // an edge is present as an edge rather than as a bright face.
    assert!(
        brightest >= 190,
        "the brightest pixel is {brightest} — the edges have been averaged \
         away and the solid has no outlines"
    );
}
