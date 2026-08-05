// =====================================================================
// A LABEL FITS ITS TILE.
//
// The label says which test drew the picture. One that runs off the
// edge names the wrong picture from a reader's point of view: two
// truncated sentences side by side are two that neither finish, and
// the second begins where the first was cut.
//
// Cut with an ellipsis rather than shrunk. Shrinking would make the
// captions vary in size according to how wordy each test's name is,
// which reads as emphasis where none was meant.
// =====================================================================

use draw::text::{ellipsised, measure};

/// A tile and its label size, for these tests.
///
/// Named here rather than taken from the gallery: the size a mosaic
/// happens to use is not what is being tested — that a label fits
/// WHATEVER width it is given is. Tying the test to the layout's
/// current numbers would make it pass or fail for reasons that have
/// nothing to do with ellipsising.
const TILE_WIDTH: usize = 960;
const LABEL_SIZE: f32 = TILE_WIDTH as f32 / 28.0;

#[test]
fn a_long_label_is_cut_to_fit() {
    let long = "a circle, as a polygon of thirty-two, drawn normal to its plane";
    let shown = ellipsised(long, LABEL_SIZE, TILE_WIDTH as i64);
    assert!(
        measure(&shown, LABEL_SIZE).width <= TILE_WIDTH as i64,
        "`{shown}` is {} wide and the tile is {TILE_WIDTH}",
        measure(&shown, LABEL_SIZE).width
    );
}

#[test]
fn a_short_label_is_untouched() {
    let short = "a hexagon";
    assert_eq!(
        ellipsised(short, LABEL_SIZE, TILE_WIDTH as i64),
        short,
        "a label that fits should not be cut"
    );
}

#[test]
fn every_label_of_the_suite_fits() {
    // The captions actually in use, at the size actually used. A test
    // whose name grew past the tile is one this catches before the
    // mosaic does.
    for label in [
        "a circle, as a polygon of thirty-two",
        "a coarse circle, so the steps show",
        "a rectangle from two corners",
        "a rectangle winds counter-clockwise whichever corners are given",
        "a tessellated box",
        "a square about its centre",
    ] {
        let shown = ellipsised(label, LABEL_SIZE, TILE_WIDTH as i64);
        assert!(
            measure(&shown, LABEL_SIZE).width <= TILE_WIDTH as i64,
            "`{shown}` overflows"
        );
    }
}
