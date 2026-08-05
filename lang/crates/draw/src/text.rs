// =====================================================================
// draw/text.rs — LABELS, TYPESET.
//
// The labels used to be a 5x7 bitmap font drawn by hand. No dependency
// and deterministic by construction, but not scalable: at 1440p every
// glyph is a magnified block, which is what a mosaic looks like when
// its pictures are sharp and its captions are not.
//
// Now they are rasterised from a real font by `swash`, shaped by
// `rustybuzz`. What that buys, in order of how much it matters here:
//
//   metrics    a line can be MEASURED before it is drawn, which is
//              what wrapping, centring and an ellipsis all rest on
//   coverage   glyphs with anti-aliased edges, like the lines
//   shaping    kerning and ligatures, which is the part a bitmap font
//              cannot approximate at all
//
// THE FONT IS IN THE REPOSITORY
// -----------------------------
// Not read from the system. A font read from the machine makes the
// picture depend on which fonts happen to be installed, so the same
// suite would draw different images in different places — and the
// difference would be invisible until someone compared two PNGs and
// found them unequal.
//
// That is the same determinism the kernel is built for: a feature tree
// regenerates into identical geometry, and the pictures of it should
// regenerate identically too.
// =====================================================================

use rustybuzz::{Face as ShapingFace, UnicodeBuffer};
use swash::scale::{Render, ScaleContext, Source, StrikeWith};
use swash::zeno::Vector;
use swash::FontRef;

use crate::render::Image;

/// The label font, compiled in.
///
/// Liberation Sans, under the SIL Open Font License. Metric-compatible
/// with Arial, so a label's width is predictable, and the smallest
/// general-purpose face available.
const FONT: &[u8] = include_bytes!("../fonts/LiberationSans-Regular.ttf");

/// What a string will occupy when drawn.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Extent {
    /// How far the pen travels, in pixels.
    pub width: i64,
    /// From the top of the tallest glyph to the bottom of the lowest.
    pub height: i64,
    /// How far below the baseline the lowest glyph reaches.
    pub descent: i64,
}

/// How wide and how tall a string is at a size.
///
/// Measured by SHAPING it rather than by summing character widths:
/// kerning moves glyphs relative to each other, so the sum of the
/// parts is not the width of the whole. A label centred on the sum is
/// centred slightly wrong, and the error grows with the text.
pub fn measure(text: &str, size: f32) -> Extent {
    let Some(face) = ShapingFace::from_slice(FONT, 0) else {
        return Extent { width: 0, height: 0, descent: 0 };
    };
    let mut buffer = UnicodeBuffer::new();
    buffer.push_str(text);
    let shaped = rustybuzz::shape(&face, &[], buffer);

    let units = face.units_per_em() as f32;
    let scale = size / units;

    let advance: i32 = shaped.glyph_positions().iter().map(|p| p.x_advance).sum();
    Extent {
        width: (advance as f32 * scale).round() as i64,
        height: ((face.ascender() - face.descender()) as f32 * scale).round() as i64,
        descent: (-face.descender() as f32 * scale).round() as i64,
    }
}

/// Draws a string with its LEFT edge at `x` and its BASELINE at `y`.
///
/// The baseline rather than the top, because that is what glyphs are
/// positioned against: two strings share a baseline whatever they
/// contain, where two tops differ by whether either has a capital.
pub fn draw_text(image: &mut Image, text: &str, x: i64, y: i64, size: f32, colour: [u8; 3]) {
    let Some(face) = ShapingFace::from_slice(FONT, 0) else {
        return;
    };
    let Some(font) = FontRef::from_index(FONT, 0) else {
        return;
    };

    let mut buffer = UnicodeBuffer::new();
    buffer.push_str(text);
    let shaped = rustybuzz::shape(&face, &[], buffer);

    let units = face.units_per_em() as f32;
    let scale = size / units;

    let mut context = ScaleContext::new();
    let mut scaler = context.builder(font).size(size).hint(false).build();

    let mut pen = 0f32;
    for (info, position) in shaped
        .glyph_infos()
        .iter()
        .zip(shaped.glyph_positions().iter())
    {
        let at_x = pen + position.x_offset as f32 * scale;
        let at_y = -(position.y_offset as f32) * scale;

        // Rendered at the glyph's SUBPIXEL position, so a run of text
        // is spaced as the metrics say rather than snapped to whole
        // pixels. Snapping is what makes hand-spaced text look uneven.
        let offset = Vector::new(at_x.fract(), 0.0);
        let rendered = Render::new(&[
            Source::ColorOutline(0),
            Source::ColorBitmap(StrikeWith::BestFit),
            Source::Outline,
        ])
        .offset(offset)
        .render(&mut scaler, info.glyph_id as u16);

        if let Some(glyph) = rendered {
            let left = x + at_x.floor() as i64 + glyph.placement.left as i64;
            let top = y + at_y.round() as i64 - glyph.placement.top as i64;

            for row in 0..glyph.placement.height as i64 {
                for column in 0..glyph.placement.width as i64 {
                    let coverage =
                        glyph.data[(row * glyph.placement.width as i64 + column) as usize];
                    if coverage > 0 {
                        image.blend_over(
                            left + column,
                            top + row,
                            coverage as i64,
                            colour,
                        );
                    }
                }
            }
        }

        pen += position.x_advance as f32 * scale;
    }
}

/// A string broken into lines that each fit in `room` pixels.
///
/// Broken at SPACES only. A break inside a word is one a reader has to
/// undo, and a label is short enough that a word too long to fit is
/// better overflowing than hyphenated by a rule that does not know the
/// language.
pub fn wrapped(text: &str, size: f32, room: i64) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();

    for word in text.split_whitespace() {
        let candidate = if current.is_empty() {
            word.to_string()
        } else {
            format!("{current} {word}")
        };

        if measure(&candidate, size).width <= room || current.is_empty() {
            current = candidate;
        } else {
            lines.push(std::mem::take(&mut current));
            current = word.to_string();
        }
    }

    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

/// A string cut to fit in `room` pixels, ending in an ellipsis.
///
/// For one line that must not wrap — a tile's caption, where a second
/// line would push into the picture below.
///
/// Cut by measuring rather than by counting characters: an `m` is
/// three times an `i`, so a fixed character count either cuts short or
/// overflows depending on what the text happens to be.
pub fn ellipsised(text: &str, size: f32, room: i64) -> String {
    if measure(text, size).width <= room {
        return text.to_string();
    }

    const ELLIPSIS: char = '…';
    let mut kept = String::new();

    for character in text.chars() {
        let candidate = format!("{kept}{character}{ELLIPSIS}");
        if measure(&candidate, size).width > room {
            break;
        }
        kept.push(character);
    }

    // Even the ellipsis alone may not fit. Whatever is left is what
    // there is room for — a panic here would be a caption killing a
    // picture.
    if kept.is_empty() {
        return String::new();
    }
    format!("{kept}{ELLIPSIS}")
}
