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
/// How big each rendered tile is.
///
/// Sized so three across make a 2560-pixel mosaic: these pictures are
/// looked at rather than glanced past, and a 320-pixel tile is one
/// where a circle's steps and a stroke's placement are below what the
/// screen can show.
///
/// Everything else scales from here — the vertex marks, the label —
/// so the proportions hold whatever this is set to.
pub const TILE_WIDTH: usize = 840;
pub const TILE_HEIGHT: usize = 680;

pub struct Tile {
    pub label: String,
    pub image: Image,
}

/// The gaps and the label, in proportion to the tile.
///
/// Derived rather than fixed, so raising the tile size does not leave
/// a thin border and unreadable text around a large picture.
const PADDING: usize = TILE_WIDTH / 27;
const LABEL_HEIGHT: usize = TILE_WIDTH / 15;
/// How tall the label text is, in pixels.
///
/// One size for every label, whatever it says. Shrinking a long one to
/// fit would make the mosaic's captions vary in size according to how
/// wordy each test's name happens to be, which reads as emphasis where
/// none was meant — so a label too long is CUT instead, with an
/// ellipsis saying so.
pub const LABEL_SIZE: f32 = TILE_WIDTH as f32 / 28.0;

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
        // Cut to fit, with a little room either side so a full-width
        // caption does not touch the tile's edge.
        let room = TILE_WIDTH.saturating_sub(PADDING * 2) as i64;
        let shown = ellipsised(text, LABEL_SIZE, room);
        let extent = measure(&shown, LABEL_SIZE);
        let text_left = left as i64 + (TILE_WIDTH as i64 - extent.width) / 2;

        // Positioned by its BASELINE, sitting far enough below the
        // picture that a descender clears it.
        let baseline = (top + TILE_HEIGHT + LABEL_HEIGHT) as i64 - extent.descent - 2;
        draw_text(&mut page, &shown, text_left, baseline, LABEL_SIZE, LABEL);
    }

    write_png(&page, path)?;
    Ok(tiles.len())
}
