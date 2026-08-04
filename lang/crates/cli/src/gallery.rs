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

use crate::render::{draw_text, text_width, write_png, Image};
use crate::scene::{TILE_HEIGHT, TILE_WIDTH};

/// One entry: a rendered image and what to call it.
///
/// The image itself rather than a path to one. An earlier version wrote
/// each tile out and read it back to compose them, which meant carrying
/// a PNG decoder for files this program had just written — code whose
/// only input was its own output.
pub struct Tile {
    pub label: String,
    pub image: Image,
}

const PADDING: usize = 12;
const LABEL_HEIGHT: usize = 22;
const LABEL_SCALE: usize = 2;

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

    let cell_width = TILE_WIDTH + PADDING;
    let cell_height = TILE_HEIGHT + LABEL_HEIGHT + PADDING;
    let width = columns * cell_width + PADDING;
    let height = rows * cell_height + PADDING;

    let mut page = Image::new(width, height);
    page.fill(0, 0, width as i64, height as i64, PAGE);

    for (index, tile) in tiles.iter().enumerate() {
        let column = index % columns;
        let row = index / columns;
        let left = PADDING + column * cell_width;
        let top = PADDING + row * cell_height;

        // A frame slightly larger than the tile, so each picture reads as
        // a separate thing rather than as part of its neighbour.
        page.fill(
            left as i64 - 1,
            top as i64 - 1,
            TILE_WIDTH as i64 + 2,
            (TILE_HEIGHT + LABEL_HEIGHT) as i64 + 2,
            FRAME,
        );

        page.blit(&tile.image, left, top);

        // Centred under its picture.
        let text = &tile.label;
        let width_of_text = text_width(text, LABEL_SCALE);
        let text_left = left + TILE_WIDTH.saturating_sub(width_of_text) / 2;
        draw_text(
            &mut page,
            text,
            text_left as i64,
            (top + TILE_HEIGHT + 6) as i64,
            LABEL_SCALE,
            LABEL,
        );
    }

    write_png(&page, path)?;
    Ok(tiles.len())
}
