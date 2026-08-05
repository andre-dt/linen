// =====================================================================
// A DRAWN LINE IS CENTRED ON THE GEOMETRY IT DRAWS.
//
// A draft's wire has no physical thickness — it is an imaginary
// boundary, like the origin axes. So the drawn width means nothing and
// can be anything, but WHERE it sits means everything: the visual
// centre of the stroke has to be the true path, or the boundary a user
// is inspecting is not where the picture says.
//
// That is what rules out plain Bresenham. It picks the NEAREST pixel at
// each step, so the drawn pixels land alternately left and right of the
// true line — the stroke wanders up to half a pixel, and which way
// depends on where along the line you look.
//
// Coverage fixes it: each pixel is weighted by how much of it the line
// covers, so the centre of MASS falls on the true path even when no
// single pixel is centred on it.
// =====================================================================

use draw::render::{line_into, Image};

const INK: [u8; 3] = [255, 255, 255];

/// How much ink landed at a pixel, 0 to 255.
///
/// Measured ABOVE the background, which is not black: an image starts
/// at [18,20,26], so reading the raw channel counts every untouched
/// pixel as a fifteenth of a stroke — and with a thousand of them in a
/// column, the background outweighs the line.
fn ink(image: &Image, x: i64, y: i64) -> i64 {
    let background = 18i64;
    image
        .at(x, y)
        .map(|colour| (colour[0] as i64 - background).max(0))
        .unwrap_or(0)
}

/// The ink-weighted centre of one column, in 256ths of a pixel.
///
/// This is the number that matters: it is where the stroke actually
/// appears to be, as against where the geometry says it is.
fn centre_of_column(image: &Image, x: i64) -> Option<i64> {
    let mut weight = 0i64;
    let mut moment = 0i64;
    for y in 0..image.height as i64 {
        let amount = ink(image, x, y);
        weight += amount;
        moment += amount * y * 256;
    }
    if weight == 0 {
        return None;
    }
    Some(moment / weight)
}

#[test]
fn a_horizontal_line_lands_on_its_row() {
    let mut image = Image::new(32, 32);
    line_into(&mut image, (2, 10), (29, 10), INK);
    for x in 3..29 {
        assert_eq!(
            centre_of_column(&image, x),
            Some(10 * 256),
            "column {x} should be centred exactly on row 10"
        );
    }
}

#[test]
fn a_diagonal_line_is_centred_at_every_column() {
    // The case Bresenham gets wrong. A 2:1 slope passes through the
    // middle of a pixel at every other column, and Bresenham has to
    // round — so half the columns are drawn half a pixel off.
    let mut image = Image::new(64, 64);
    line_into(&mut image, (4, 8), (44, 28), INK);

    for x in 6..42 {
        let along = x - 4;
        // The true y at this column, in 256ths.
        let wanted = 8 * 256 + along * 20 * 256 / 40;
        let found = centre_of_column(&image, x).expect("the line should reach this column");
        assert!(
            (found - wanted).abs() <= 32,
            "column {x}: the stroke sits at {found}/256 but the line is at {wanted}/256"
        );
    }
}

#[test]
fn a_shallow_line_is_centred_where_bresenham_would_round() {
    // A slope that never passes through a pixel centre: every column's
    // true y is a fraction, so a single-pixel line is off by up to half
    // a pixel at every one of them.
    let mut image = Image::new(64, 64);
    line_into(&mut image, (2, 10), (58, 17), INK);

    let mut worst = 0i64;
    for x in 4..56 {
        let along = x - 2;
        let wanted = 10 * 256 + along * 7 * 256 / 56;
        let found = centre_of_column(&image, x).expect("the line should reach this column");
        worst = worst.max((found - wanted).abs());
    }
    assert!(
        worst <= 32,
        "the stroke wanders {worst}/256 of a pixel from the line at its worst"
    );
}

#[test]
fn a_line_above_the_origin_draws_like_its_mirror_below() {
    // Rounding toward zero and rounding toward negative infinity agree
    // for positive coordinates and DISAGREE below zero. A line that
    // stays in the lower half of the image never reaches the
    // difference, so this one is drawn across y = 0 and compared with
    // its own mirror image.
    //
    // Mirrored rather than measured directly, because a pixel above the
    // image is not drawn and cannot be read back. What can be read is
    // that the geometry's symmetry survived: reflecting the line has to
    // reflect the picture.
    //
    // Truncating division breaks exactly this — it bunches the ink
    // toward y = 0 from below and not from above.
    // Straddling y = 0: part of it is above the image and unreadable,
    // and the part below it is what gets compared.
    let mut crossing = Image::new(64, 64);
    line_into(&mut crossing, (4, -20), (60, 8), INK);

    // The same line shifted down by 40, entirely inside the image and
    // entirely at positive y — where the two roundings agree. Reading
    // row `y` of one against row `y + 40` of the other compares the
    // same part of the same geometry.
    let mut shifted = Image::new(64, 64);
    line_into(&mut shifted, (4, 20), (60, 48), INK);

    for x in 4..60 {
        for y in 0..24 {
            assert_eq!(
                ink(&crossing, x, y),
                ink(&shifted, x, y + 40),
                "pixel ({x},{y}) differs from the same geometry drawn 40 rows lower: \
                 the rounding is not the same on both sides of zero"
            );
        }
    }
}

#[test]
fn the_two_ends_are_drawn() {
    // A line that stopped short would be a boundary that is not where
    // it says — the same defect as an off-centre one, at the ends.
    let mut image = Image::new(32, 32);
    line_into(&mut image, (5, 5), (25, 25), INK);
    assert!(ink(&image, 5, 5) > 0, "the first point should be drawn");
    assert!(ink(&image, 25, 25) > 0, "the last point should be drawn");
}

#[test]
fn a_line_and_its_reverse_draw_the_same_stroke() {
    // Symmetry in the other sense: the geometry does not know which end
    // was written first, so the picture must not either. Bresenham's
    // rounding is direction-dependent and fails this on the ties.
    let mut forward = Image::new(48, 48);
    let mut backward = Image::new(48, 48);
    line_into(&mut forward, (3, 7), (44, 31), INK);
    line_into(&mut backward, (44, 31), (3, 7), INK);

    for y in 0..48 {
        for x in 0..48 {
            assert_eq!(
                ink(&forward, x, y),
                ink(&backward, x, y),
                "pixel ({x},{y}) differs depending on which end was drawn first"
            );
        }
    }
}

#[test]
fn every_column_of_a_stroke_carries_one_pixel_of_ink() {
    // What says the line is one pixel WIDE: not two where it happens to
    // straddle, and not a half where it happens to align.
    //
    // Per COLUMN rather than in total. Wu steps along the major axis,
    // so a 45-degree line takes the same number of steps as a
    // horizontal one of the same span — the total is the span, not the
    // length, and a diagonal is genuinely fainter per unit length. That
    // is Wu's known cost, and it is the right trade here: the stroke's
    // POSITION is what a draft depends on.
    let mut image = Image::new(64, 64);
    line_into(&mut image, (2, 8), (50, 30), INK);

    for x in 4..48 {
        let mut column = 0i64;
        for y in 0..64 {
            column += ink(&image, x, y);
        }
        assert!(
            (column - 237).abs() <= 24,
            "column {x} carries {column} of ink where one pixel is about 237"
        );
    }
}

// =====================================================================
// An outline drawn over a face is CONTINUOUS.
//
// The anti-aliased line writes partial coverage, and a partly-covered
// pixel is mostly the face behind it — so it does not claim the near
// depth. That is right: claiming it would hide what is still visible
// through the gap.
//
// But it means an edge pixel can lose the depth test to its own face,
// and the stroke comes out DOTTED — solid where it happened to cover a
// pixel fully, gone where it did not. A boundary with holes in it is
// the same lie as one in the wrong place.
// =====================================================================

use draw::render::{render, Mesh, MeshKind, Point3, View};

#[test]
fn an_interior_edge_is_not_dotted() {
    // The edge BETWEEN two faces, drawn over them rather than against
    // the background.
    //
    // The anti-aliased stroke writes partial coverage, and a
    // partly-covered pixel is mostly the face behind it — so it does
    // not claim the near depth. That is right in itself: claiming it
    // would hide what is still visible through the gap. But it means
    // the pixel loses the depth test to its own face, and the edge
    // comes out drawn on every OTHER column.
    //
    // A boundary with holes in it is the same lie as one in the wrong
    // place, so it is measured here: along the edge, column by column.
    let mesh = box_mesh(400);
    let image = render(&mesh, 320, 260, View::Isometric);

    // The middle band, where the three interior edges of a box meet.
    let mut drawn = Vec::new();
    for x in 100..220 {
        let mut bright = 0;
        for y in 60..200 {
            let Some(colour) = image.at(x, y) else { continue };
            if colour[0] as i64 + colour[1] as i64 + colour[2] as i64 > 500 {
                bright += 1;
            }
        }
        drawn.push(bright > 0);
    }

    // The vertical edge is one column, but the two sloping ones cross
    // this band continuously — so a long run of empty columns among
    // drawn ones is the stroke breaking up.
    let mut gaps = 0;
    for pair in drawn.windows(3) {
        if pair[0] && !pair[1] && pair[2] {
            gaps += 1;
        }
    }
    assert!(
        gaps < 4,
        "the interior edge is drawn on every other column — {gaps} single-column gaps \
         along it, which is the stroke losing the depth test to its own face"
    );
}

/// A cube, as triangles: eight corners, twelve triangles.
fn box_mesh(size: i64) -> Mesh {
    Mesh {
        points: vec![
            Point3 { x: 0, y: 0, z: 0 },
            Point3 { x: size, y: 0, z: 0 },
            Point3 { x: size, y: size, z: 0 },
            Point3 { x: 0, y: size, z: 0 },
            Point3 { x: 0, y: 0, z: size },
            Point3 { x: size, y: 0, z: size },
            Point3 { x: size, y: size, z: size },
            Point3 { x: 0, y: size, z: size },
        ],
        triangles: vec![
            0, 2, 1, 0, 3, 2, // bottom
            4, 5, 6, 4, 6, 7, // top
            0, 1, 5, 0, 5, 4, // front
            1, 2, 6, 1, 6, 5, // right
            2, 3, 7, 2, 7, 6, // back
            3, 0, 4, 3, 4, 7, // left
        ],
        kind: MeshKind::Solid,
    }
}

// =====================================================================
// A VERTEX IS A DISC, NOT A SQUARE.
//
// A draft's points are what the draft IS — the segments between them
// are derived — so they are drawn rather than left implied. Onshape
// draws them as small round dots, and round is not decoration: a square
// has corners that read as direction, and a point has none.
//
// Anti-aliased for the same reason the lines are. A three-pixel square
// is visibly bigger along its diagonal than across its face, so a row
// of vertices appears to change size as the path turns.
// =====================================================================

use draw::render::{dot_into, dot_sized};

#[test]
fn a_vertex_is_round() {
    // The corners of the bounding box are lighter than the edges: that
    // is what makes it a disc rather than a square.
    let mut image = Image::new(24, 24);
    dot_into(&mut image, (12, 12), INK);

    let centre = ink(&image, 12, 12);
    // One pixel out along an axis, and one pixel out diagonally. The
    // diagonal is further from the centre — by a factor of root two —
    // so a disc carries less ink there and a square carries the same.
    let edge = ink(&image, 12, 11);
    let corner = ink(&image, 11, 11);

    assert!(centre > 200, "the middle should be solid, got {centre}");
    assert!(
        corner < edge,
        "the corner of the bounding box carries {corner} and the edge {edge} — \
         a square would carry the same at both"
    );
}

#[test]
fn a_vertex_is_symmetric() {
    // Round means round in every direction. An asymmetric dot puts the
    // apparent point somewhere the geometry is not, which is the same
    // defect as an off-centre line.
    let mut image = Image::new(24, 24);
    dot_into(&mut image, (12, 12), INK);

    for offset in 1..=4 {
        let right = ink(&image, 12 + offset, 12);
        let left = ink(&image, 12 - offset, 12);
        let below = ink(&image, 12, 12 + offset);
        let above = ink(&image, 12, 12 - offset);
        assert_eq!(right, left, "the dot is lopsided in x at {offset} out");
        assert_eq!(below, above, "the dot is lopsided in y at {offset} out");
        assert_eq!(right, below, "the dot is wider than it is tall at {offset} out");
    }
}

#[test]
fn a_vertex_fades_at_its_rim() {
    // Anti-aliased, so a dot has no jagged outline. Without it a
    // three-pixel disc is a plus sign.
    let mut image = Image::new(24, 24);
    dot_into(&mut image, (12, 12), INK);

    let mut partial = 0;
    for y in 8..=16 {
        for x in 8..=16 {
            let amount = ink(&image, x, y);
            if amount > 0 && amount < 200 {
                partial += 1;
            }
        }
    }
    assert!(
        partial >= 8,
        "only {partial} pixels are partly covered — the rim is hard, not faded"
    );
}

#[test]
fn a_vertex_is_small() {
    // Small enough to mark a point rather than to be a shape. A dot as
    // big as the gap between two vertices reads as a blob.
    let mut image = Image::new(32, 32);
    dot_into(&mut image, (16, 16), INK);

    for x in 0..32 {
        for y in 0..32 {
            let far = (x - 16) * (x - 16) + (y - 16) * (y - 16);
            if far > 16 {
                assert_eq!(
                    ink(&image, x, y),
                    0,
                    "({x},{y}) is more than four pixels out and still has ink"
                );
            }
        }
    }
}

#[test]
fn a_wire_marks_its_vertices() {
    // A draft's points are what the draft IS — the segments between
    // them are derived — so they are drawn rather than left implied.
    //
    // Measured rather than looked at: a dot on a straight run of a
    // wire is the same colour as the line and reads as part of it, so
    // the eye cannot tell whether it is there. What can be told is that
    // the pixel AT the vertex is fuller than the line either side.
    let mesh = Mesh {
        points: vec![
            Point3 { x: 0, y: 0, z: 0 },
            Point3 { x: 400, y: 0, z: 0 },
            Point3 { x: 400, y: 300, z: 0 },
            Point3 { x: 0, y: 300, z: 0 },
        ],
        triangles: vec![0, 1, 1, 2, 2, 3, 3, 0],
        kind: MeshKind::Wire,
    };
    let image = render(&mesh, 200, 160, View::Top);

    // The wire's corners in screen space: the extremes of the drawn
    // ink. A dot makes each corner thicker than the runs leading to it.
    let mut left = i64::MAX;
    let mut right = i64::MIN;
    let mut top = i64::MAX;
    let mut bottom = i64::MIN;
    for y in 0..160 {
        for x in 0..200 {
            if ink(&image, x, y) > 40 {
                left = left.min(x);
                right = right.max(x);
                top = top.min(y);
                bottom = bottom.max(y);
            }
        }
    }

    // How much ink sits within two pixels of a corner, against the same
    // patch taken from the middle of an edge.
    let patch = |cx: i64, cy: i64| {
        let mut sum = 0i64;
        for y in cy - 2..=cy + 2 {
            for x in cx - 2..=cx + 2 {
                sum += ink(&image, x, y);
            }
        }
        sum
    };

    let corner = patch(left + 1, top + 1);
    let middle = patch((left + right) / 2, top + 1);
    assert!(
        corner > middle,
        "a corner carries {corner} of ink and a straight run {middle} — \
         the vertex is not being marked"
    );
}

#[test]
fn a_vertex_is_the_same_shape_at_any_size() {
    // The dot scales with the tile. At 320 pixels wide a 2.5-pixel disc
    // reads as a square — there are not enough pixels for the rim to
    // fall anywhere but the corners — and at 2560 the same disc is a
    // speck.
    //
    // What must not change is the SHAPE: round at both sizes, and
    // round means the corner of its bounding box is lighter than the
    // edge, whatever the radius.
    for radius in [5i64, 10, 20] {
        let mut image = Image::new(64, 64);
        dot_sized(&mut image, (32, 32), radius, INK);

        let out = (radius / 4).max(1);
        let edge = ink(&image, 32, 32 - out);
        let corner = ink(&image, 32 - out, 32 - out);
        assert!(
            corner < edge,
            "at radius {radius} the corner carries {corner} and the edge {edge} — \
             that is a square, not a disc"
        );

        // And symmetric, at every size.
        for offset in 1..=(radius / 4).max(1) {
            assert_eq!(
                ink(&image, 32 + offset, 32),
                ink(&image, 32 - offset, 32),
                "lopsided in x at radius {radius}"
            );
            assert_eq!(
                ink(&image, 32, 32 + offset),
                ink(&image, 32 - offset, 32),
                "taller than it is wide at radius {radius}"
            );
        }
    }
}

#[test]
fn a_written_png_is_compressed() {
    // The mosaics are 2560 pixels across and go into git. Uncompressed
    // they are twelve megabytes each, which is not a file anyone wants
    // in a history — and the content is flat colour on a flat
    // background, which is the easiest thing there is to compress.
    let mut image = Image::new(800, 600);
    // Something with real content: a solid and its outline.
    for x in 100..700 {
        for y in 200..400 {
            image.set(x, y, [96, 146, 226]);
        }
    }
    let bytes = draw::render::encode_png(&image);

    let raw = 800 * 600 * 3;
    assert!(
        bytes.len() < raw / 8,
        "the PNG is {} bytes for {raw} of pixels — barely compressed at all",
        bytes.len()
    );
}

#[test]
fn a_compressed_png_still_says_what_it_is() {
    // Compression that corrupts the file is worse than none. The
    // signature and the dimensions have to survive it.
    let image = Image::new(64, 48);
    let bytes = draw::render::encode_png(&image);

    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "not a PNG");
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    assert_eq!(width, 64);
    assert_eq!(height, 48);
}
