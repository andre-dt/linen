// =====================================================================
// format — ONE ORDER FOR EVERY FILE.
//
//   the file's own header comment
//   the imports, as one block
//   the shapes
//   the functions
//   the tests, by title
//   the drawing tests, by title
//
// One blank line between each, and nothing else.
//
// WHY SORTED AND NOT GROUPED BY TOPIC
// -----------------------------------
// A section comment — `# --- rectangles ---` — is a claim about where
// things are, and it is wrong the moment someone adds one in the wrong
// place. Alphabetical order is a claim that checks itself: a reader
// looking for a test knows where it is without trusting anyone.
//
// WHY A COMMENT MOVES WITH WHAT IT EXPLAINS
// -----------------------------------------
// Because it is part of it. The parser attaches the block above a
// declaration to that declaration, so this does not have to guess —
// and guessing is exactly how an explanation ends up describing the
// wrong thing.
//
// DRAWING TESTS LAST
// ------------------
// They are the ones a reader opens the file to look at, and the ones
// whose output is a picture rather than a pass. Kept together at the
// end so the mosaic's order and the file's order agree.
//
// Its own crate because it is a function from a string to a string.
// Asking whether a file is in order should not mean building a
// compiler, still less running one.
// =====================================================================

use syntax::ast::*;

/// One file, in the canonical order.
pub fn rewrite(source: &str) -> Result<String, String> {
    let (tokens, comments) =
        syntax::lex::lex_with_comments(source).map_err(|error| error.message)?;
    let unit =
        syntax::parse::parse_with_comments(&tokens, &comments).map_err(|error| error.message)?;

    let lines: Vec<&str> = source.split('\n').collect();
    let mut chunks: Vec<String> = Vec::new();

    // The file's own header: the comment block at the top, which the
    // parser did not attach to anything because a blank line follows
    // it. It describes the file, so it stays first.
    if let Some(header) = header_of(&lines) {
        chunks.push(header);
    }

    let mut imports = Vec::new();
    let mut shapes = Vec::new();
    let mut functions = Vec::new();
    let mut tests = Vec::new();
    let mut drawings = Vec::new();

    for item in &unit.items {
        match item {
            Item::Import(import) => imports.push((String::new(), text_of(&lines, import.span))),
            Item::Shape(shape) => shapes.push((
                shape.name.clone(),
                with_comment(&shape.comment, text_of(&lines, shape.span)),
            )),
            Item::Function(function) => functions.push((
                function.name.clone(),
                with_comment(&function.comment, text_of(&lines, function.span)),
            )),
            Item::Test(test) => {
                let entry = (
                    test.name.to_lowercase(),
                    with_comment(&test.comment, text_of(&lines, test.span)),
                );
                if test.draws {
                    drawings.push(entry);
                } else {
                    tests.push(entry);
                }
            }
        }
    }

    // Imports and shapes keep the order they were written: an import
    // list is read as a whole, and a shape's order is often the order
    // it is built up in. Only the tests are sorted, because a test is
    // looked up by name and a hundred of them in written order is a
    // hundred places to look.
    tests.sort_by(|a, b| a.0.cmp(&b.0));
    drawings.sort_by(|a, b| a.0.cmp(&b.0));

    // The imports as ONE block, not one chunk each: they are read
    // together — the top of a file answers where every name in it came
    // from — and a blank line between each turns that into a list to
    // scroll past.
    if !imports.is_empty() {
        chunks.push(
            imports
                .into_iter()
                .map(|(_, text)| text)
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }

    for group in [shapes, functions, tests, drawings] {
        for (_, text) in group {
            chunks.push(text);
        }
    }

    Ok(chunks.join("\n\n") + "\n")
}

/// The comment block at the top of the file, if there is one.
///
/// Found by text rather than from the AST, because the parser
/// deliberately does NOT attach it: a blank line separates it from the
/// first declaration, which is what says it is about the file.
///
/// So the blank line is what makes it a header. Without one, the block
/// belongs to the declaration under it — and taking it as the header
/// would strand an explanation at the top of a file, above whatever
/// sorting happened to put first.
fn header_of(lines: &[&str]) -> Option<String> {
    if !lines.first()?.starts_with('#') {
        return None;
    }
    let end = lines.iter().position(|line| !line.starts_with('#'))?;
    if !lines.get(end)?.trim().is_empty() {
        return None;
    }
    Some(lines[..end].join("\n"))
}

/// The source text a span covers, whole lines.
///
/// The END is taken one byte back. A span reaches PAST its last
/// character — that is what makes `start..end` a range — so asking
/// which line `end` falls on gives the line after the declaration
/// whenever it ends at a line break. Every declaration does.
fn text_of(lines: &[&str], span: syntax::token::Span) -> String {
    let start = line_at(lines, span.start);
    let end = line_at(lines, span.end.saturating_sub(1));
    let mut taken: Vec<&str> = lines[start..=end.min(lines.len() - 1)].to_vec();

    // Trailing comment lines belong to the NEXT declaration, not this
    // one. A span is measured in whole lines, and a comment written
    // between two declarations falls inside the first one's range — so
    // without this the comment is emitted twice: once at the end of
    // what it does not describe, and once above what it does.
    while taken
        .last()
        .is_some_and(|line| line.trim().is_empty() || line.trim_start().starts_with('#'))
    {
        taken.pop();
    }

    taken.join("\n").trim_end().to_string()
}

/// Which line a byte offset falls on.
fn line_at(lines: &[&str], offset: usize) -> usize {
    let mut seen = 0;
    for (index, line) in lines.iter().enumerate() {
        seen += line.len() + 1;
        if offset < seen {
            return index;
        }
    }
    lines.len().saturating_sub(1)
}

/// A declaration with its own comment above it.
///
/// Prepended only when the text does not already carry it. A
/// declaration's span starts at its keyword, but a comment written
/// above it sometimes falls inside the PREVIOUS declaration's line
/// range — so adding it unconditionally wrote it twice, and the file
/// grew a copy on every run.
fn with_comment(comment: &Option<String>, text: String) -> String {
    let Some(comment) = comment else {
        return text;
    };
    let commented: Vec<String> = comment
        .split('\n')
        .map(|line| if line.is_empty() { "#".to_string() } else { format!("# {line}") })
        .collect();
    let commented = commented.join("\n");
    if text.starts_with(&commented) {
        return text;
    }
    format!("{commented}\n{text}")
}
