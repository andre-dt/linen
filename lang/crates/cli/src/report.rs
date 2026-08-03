// =====================================================================
// cli/report.rs — TURNING A SPAN INTO SOMETHING A PERSON CAN READ.
//
// Everything upstream carries byte offsets, which are cheap and exact
// and mean nothing to a human. This is the one place that converts, so
// line and column are computed only for the handful of spans that end up
// in a message rather than for every token.
//
//   path/to/file.lang:3:10: expected `)` to close the assert
//     assert(1 + 1
//                 ^
//
// The source line is quoted with a caret under it. A message without the
// line makes the reader go look; with it, the mistake is right there.
// =====================================================================

use std::path::Path;

use syntax::token::Span;

/// One diagnostic, ready to print.
#[derive(Debug)]
pub struct Report {
    pub text: String,
}

impl Report {
    pub fn new(file: &Path, source: &str, span: Span, message: &str) -> Report {
        let (line_number, column, line) = locate(source, span.start);

        let mut text = format!(
            "{}:{}:{}: {}\n",
            file.display(),
            line_number,
            column,
            message
        );
        text.push_str(&format!("  {line}\n"));

        // The caret sits under the span's start. Tabs would misalign it,
        // but the lexer rejects tabs for indentation, so any that reach
        // here are inside a literal and rare enough not to complicate
        // this.
        text.push_str(&format!("  {}^\n", " ".repeat(column.saturating_sub(1))));
        Report { text }
    }

    pub fn print(&self) {
        eprint!("{}", self.text);
    }
}

/// Line number (1-based), column (1-based) and the text of the line
/// holding `offset`.
fn locate(source: &str, offset: usize) -> (usize, usize, &str) {
    // Clamped: a span pointing at the end of the file is legitimate —
    // "expected something, found the end" — and indexing past the last
    // byte would panic on the one error that says so.
    let offset = offset.min(source.len());

    let before = &source[..offset];
    let line_number = before.matches('\n').count() + 1;
    let line_start = before.rfind('\n').map(|at| at + 1).unwrap_or(0);
    let line_end = source[line_start..]
        .find('\n')
        .map(|at| line_start + at)
        .unwrap_or(source.len());

    (line_number, offset - line_start + 1, &source[line_start..line_end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_first_line() {
        let (line, column, text) = locate("hello\nworld\n", 0);
        assert_eq!((line, column), (1, 1));
        assert_eq!(text, "hello");
    }

    #[test]
    fn finds_a_later_line_and_column() {
        // Offset 8 is the `r` of `world`: second line, third column.
        let (line, column, text) = locate("hello\nworld\n", 8);
        assert_eq!((line, column), (2, 3));
        assert_eq!(text, "world");
    }

    #[test]
    fn survives_a_span_at_the_very_end() {
        // "expected X, found the end of the file" points here, so this
        // is the one offset that must not panic.
        let (line, _, _) = locate("hello\n", 6);
        assert_eq!(line, 2);
    }

    #[test]
    fn puts_the_caret_under_the_column() {
        let report = Report::new(
            Path::new("t.lang"),
            "assert(1 + 1\n",
            Span::new(12, 12),
            "expected `)`",
        );
        let caret_line = report.text.lines().nth(2).expect("three lines");
        // Two spaces of indent, then twelve to reach column 13.
        assert_eq!(caret_line, format!("  {}^", " ".repeat(12)));
    }

    #[test]
    fn names_the_file_line_and_column_first() {
        let report = Report::new(
            Path::new("t.lang"),
            "test \"t\"\n  assert(1\n",
            Span::new(18, 18),
            "expected `)`",
        );
        assert!(report.text.starts_with("t.lang:2:10:"), "got: {}", report.text);
    }
}
