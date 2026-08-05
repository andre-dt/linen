// =====================================================================
// TEXT THAT IS ACTUALLY TYPESET.
//
// The labels were a 5x7 bitmap font drawn by hand: no dependency, and
// deterministic by construction, but not scalable — at 1440p every
// glyph is a magnified block.
//
// Now they are rasterised from a real font. What that has to give:
// glyphs with anti-aliased edges, metrics that let a line be measured
// before it is drawn, and — from those metrics — wrapping and an
// ellipsis when a label is too long for its tile.
// =====================================================================

use draw::render::Image;
use draw::text::{draw_text, ellipsised, measure, wrapped};

const INK: [u8; 3] = [255, 255, 255];

/// How much ink is in an image, above the background.
fn total_ink(image: &Image) -> i64 {
    let mut sum = 0;
    for y in 0..image.height as i64 {
        for x in 0..image.width as i64 {
            if let Some(colour) = image.at(x, y) {
                sum += (colour[0] as i64 - 18).max(0);
            }
        }
    }
    sum
}

#[test]
fn text_is_drawn_at_all() {
    let mut image = Image::new(300, 60);
    draw_text(&mut image, "Hello", 10, 10, 32.0, INK);
    assert!(total_ink(&image) > 1000, "nothing was drawn");
}

#[test]
fn a_wider_string_takes_more_room() {
    let short = measure("i", 32.0);
    let long = measure("mmmmm", 32.0);
    assert!(
        long.width > short.width * 4,
        "five wide letters should be far wider than one narrow one: {} against {}",
        long.width,
        short.width
    );
}

#[test]
fn measuring_agrees_with_drawing() {
    // The measurement is what wrapping and centring rest on. If it
    // disagreed with what is drawn, a label would be centred wrong or
    // wrapped in the wrong place — and the error would be invisible
    // until someone compared the picture against the number.
    let text = "Measure twice";
    let measured = measure(text, 32.0);

    let mut image = Image::new(600, 80);
    draw_text(&mut image, text, 20, 20, 32.0, INK);

    let mut rightmost = 0i64;
    for y in 0..80 {
        for x in 0..600 {
            if image.at(x, y).is_some_and(|colour| colour[0] > 60) {
                rightmost = rightmost.max(x);
            }
        }
    }
    let drawn = rightmost - 20;
    assert!(
        (drawn - measured.width).abs() < 8,
        "measured {} wide, drew {drawn}",
        measured.width
    );
}

#[test]
fn glyphs_have_soft_edges() {
    // Anti-aliased, like the lines. A glyph with hard edges at this
    // size is the bitmap font again.
    let mut image = Image::new(200, 60);
    draw_text(&mut image, "O", 20, 10, 40.0, INK);

    let mut partial = 0;
    for y in 0..60 {
        for x in 0..200 {
            let amount = image.at(x, y).map(|c| c[0] as i64 - 18).unwrap_or(0);
            if amount > 20 && amount < 200 {
                partial += 1;
            }
        }
    }
    assert!(partial > 20, "only {partial} pixels are partly covered — the edges are hard");
}

#[test]
fn a_long_line_wraps_at_a_space() {
    // Wrapped between words, never inside one. A break inside a word
    // is one a reader has to undo.
    let lines = wrapped("the quick brown fox jumps over the lazy dog", 24.0, 200);
    assert!(lines.len() > 1, "it should have wrapped");
    for line in &lines {
        assert!(
            measure(line, 24.0).width <= 200,
            "`{line}` is {} wide and the room is 200",
            measure(line, 24.0).width
        );
        assert!(!line.starts_with(' ') && !line.ends_with(' '), "`{line}` has loose spaces");
    }
    assert_eq!(
        lines.join(" "),
        "the quick brown fox jumps over the lazy dog",
        "wrapping lost or added something"
    );
}

#[test]
fn a_word_too_long_to_fit_is_still_a_line() {
    // Nothing to break at. One line that overflows beats an infinite
    // loop looking for a space that is not there.
    let lines = wrapped("supercalifragilistic", 24.0, 40);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0], "supercalifragilistic");
}

#[test]
fn text_that_does_not_fit_is_ellipsised() {
    let cut = ellipsised("a circle, as a polygon of thirty-two", 24.0, 150);
    assert!(
        measure(&cut, 24.0).width <= 150,
        "`{cut}` is {} wide and the room is 150",
        measure(&cut, 24.0).width
    );
    assert!(cut.ends_with('…'), "`{cut}` should end with an ellipsis");
    assert!(cut.starts_with("a circ"), "`{cut}` should keep the beginning");
}

#[test]
fn text_that_fits_is_left_alone() {
    let text = "a hexagon";
    assert_eq!(
        ellipsised(text, 24.0, 500),
        text,
        "a label that fits should not be touched"
    );
}

#[test]
fn even_a_tiny_space_gives_something() {
    // Narrower than the ellipsis itself. Whatever comes back, it has to
    // be a string rather than a panic.
    let cut = ellipsised("something long", 24.0, 3);
    assert!(cut.chars().count() <= 2, "`{cut}` is too much for three pixels");
}
