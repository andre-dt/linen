// =====================================================================
// cli/gallery.rs — EVERY PICTURE ON ONE PAGE.
//
// Each test that draws produces its own PNG beside its source, which is
// what you open when one test is wrong. This assembles all of them into
// a single mosaic — which is what you glance at to see whether anything
// is wrong at all.
//
// The two are for different moments and neither replaces the other: a
// contact sheet is how you notice a solid that looks nothing like it
// should, and the individual file is how you then look closely.
//
// LABELLED, BECAUSE AN UNLABELLED GRID IS A PUZZLE
// ------------------------------------------------
// Twelve boxes that all look similar are useless without knowing which
// is which. The label is the test file's name, drawn in the same
// dependency-free bitmap font as everything else here.
// =====================================================================

use std::path::Path;

use crate::render::{write_png, Image};
use crate::text::{draw_text, ellipsised, measure};


/// One entry: a rendered image and what to call it.
///
/// The image itself rather than a path to one. An earlier version wrote
/// each tile out and read it back to compose them, which meant carrying
/// a PNG decoder for files this program had just written — code whose
/// only input was its own output.
/// How big each rendered tile is.
///
/// Here rather than with the caller, because the mosaic is what has to
/// lay them out: a tile size the gallery did not choose is a size it
/// would have to be told about at every call.
/// How big a tile is when a file draws only ONE of them.
///
/// 1920x1080: a picture looked at on its own wants to fill a screen at
/// 100%, and this is the size that does on an ordinary monitor without
/// being reduced. Larger only helps on a 4K panel, and costs everyone
/// else file size for detail their screen cannot show.
pub const TILE_WIDTH: usize = 1920;
pub const TILE_HEIGHT: usize = 1080;

/// How big a tile is once there are several on the sheet.
///
/// Half, because a mosaic is never viewed at 100% — it is the thing you
/// glance at to see whether anything looks wrong, and then you open the
/// one that does. Sized for that glance, three across still make a
/// sheet under 3000 pixels wide.
pub const MOSAIC_TILE_WIDTH: usize = 960;
pub const MOSAIC_TILE_HEIGHT: usize = 540;

/// The tile size a file with `count` drawing tests should render at.
///
/// One picture gets the full size; more than one gets the mosaic size.
/// Chosen HERE rather than by the caller, because the layout below is
/// what has to agree with it — a size the gallery did not pick is one
/// it would have to be told about and could disagree with.
pub fn tile_size(count: usize) -> (usize, usize) {
    if count <= 1 {
        (TILE_WIDTH, TILE_HEIGHT)
    } else {
        (MOSAIC_TILE_WIDTH, MOSAIC_TILE_HEIGHT)
    }
}

pub struct Tile {
    pub label: String,
    pub image: Image,
}

const PAGE: [u8; 3] = [10, 11, 15];
const FRAME: [u8; 3] = [38, 42, 52];
const LABEL: [u8; 3] = [186, 196, 212];

/// Writes the mosaic. Returns how many tiles it holds.
pub fn write_gallery(tiles: &[Tile], path: &Path) -> Result<usize, String> {
    if tiles.is_empty() {
        return Ok(0);
    }

    // As square as it goes, so the sheet fits a screen rather than
    // running off the bottom.
    let columns = (tiles.len() as f64).sqrt().ceil() as usize;
    let rows = tiles.len().div_ceil(columns);

    // Taken from the tiles themselves rather than from a constant. The
    // caller renders at whatever `tile_size` said, and reading it back
    // from the image is the only way the two cannot drift apart.
    let tile_width = tiles.iter().map(|tile| tile.image.width).max().unwrap_or(1);
    let tile_height = tiles.iter().map(|tile| tile.image.height).max().unwrap_or(1);

    // The gaps and the label, in proportion to the tile — so a small
    // tile does not get a wide border and unreadable text, and a large
    // one does not get a hairline.
    let padding = tile_width / 27;
    let label_height = tile_width / 15;
    // One text size for every label, whatever it says. Shrinking a long
    // one to fit would make the captions vary in size according to how
    // wordy each test's name happens to be, which reads as emphasis
    // where none was meant — so a label too long is CUT instead, with
    // an ellipsis saying so.
    let label_size = tile_width as f32 / 28.0;

    let cell_width = tile_width + padding;
    let cell_height = tile_height + label_height + padding;
    let width = columns * cell_width + padding;
    let height = rows * cell_height + padding;

    let mut page = Image::new(width, height);
    page.fill(0, 0, width as i64, height as i64, PAGE);

    for (index, tile) in tiles.iter().enumerate() {
        let column = index % columns;
        let row = index / columns;
        let left = padding + column * cell_width;
        let top = padding + row * cell_height;

        // A frame slightly larger than the tile, so each picture reads as
        // a separate thing rather than as part of its neighbour.
        page.fill(
            left as i64 - 1,
            top as i64 - 1,
            tile_width as i64 + 2,
            (tile_height + label_height) as i64 + 2,
            FRAME,
        );

        page.blit(&tile.image, left, top);

        // Centred under its picture.
        let text = &tile.label;
        // Cut to fit, with a little room either side so a full-width
        // caption does not touch the tile's edge.
        let room = tile_width.saturating_sub(padding * 2) as i64;
        let shown = ellipsised(text, label_size, room);
        let extent = measure(&shown, label_size);
        let text_left = left as i64 + (tile_width as i64 - extent.width) / 2;

        // Positioned by its BASELINE, sitting far enough below the
        // picture that a descender clears it.
        let baseline = (top + tile_height + label_height) as i64 - extent.descent - 2;
        draw_text(&mut page, &shown, text_left, baseline, label_size, LABEL);
    }

    write_png(&page, path)?;
    Ok(tiles.len())
}
