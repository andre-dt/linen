// =====================================================================
// syntax/lex_test.rs
//
// The layout rule is where a lexer for an indentation-sensitive language
// goes quietly wrong, so most of these are about Indent/Dedent rather
// than about recognising `+`.
// =====================================================================

use crate::lex::lex;
use crate::token::TokenKind;

/// The token kinds, without spans — spans are asserted only where the
/// test is about them.
fn kinds(source: &str) -> Vec<TokenKind> {
    lex(source).expect("should lex").into_iter().map(|t| t.kind).collect()
}

fn error(source: &str) -> String {
    lex(source).expect_err("should not lex").message
}

use TokenKind::*;

#[test]
fn lexes_an_empty_file() {
    assert_eq!(kinds(""), vec![End]);
}

#[test]
fn lexes_numbers_and_operators() {
    assert_eq!(
        kinds("2 + 40"),
        vec![Integer(2), Plus, Integer(40), Newline, End]
    );
}

#[test]
fn reads_two_character_operators_whole() {
    // Lexing `==` as two `=` tokens is the classic slip here.
    assert_eq!(kinds("1 == 2"), vec![Integer(1), EqualEqual, Integer(2), Newline, End]);
    assert_eq!(kinds("1 != 2"), vec![Integer(1), BangEqual, Integer(2), Newline, End]);
    assert_eq!(kinds("1 <= 2"), vec![Integer(1), LessEqual, Integer(2), Newline, End]);
    assert_eq!(kinds("1 >= 2"), vec![Integer(1), GreaterEqual, Integer(2), Newline, End]);
}

#[test]
fn separates_less_from_less_equal() {
    assert_eq!(kinds("1 < 2"), vec![Integer(1), Less, Integer(2), Newline, End]);
}

#[test]
fn allows_underscores_in_numbers() {
    assert_eq!(kinds("1_000_000"), vec![Integer(1_000_000), Newline, End]);
}

#[test]
fn rejects_a_number_too_large_to_hold() {
    assert!(error("99999999999999999999").contains("64-bit"));
}

#[test]
fn lexes_names_and_text() {
    assert_eq!(
        kinds("test \"arithmetic\""),
        vec![Name("test".into()), Text("arithmetic".into()), Newline, End]
    );
}

#[test]
fn reports_an_unterminated_text_on_its_own_line() {
    // Pointing at the line that opened the quote, not at the end of the
    // file, is the whole reason this is checked at the newline.
    assert!(error("test \"oops\n  assert(1)").contains("closing quote"));
}

// --- layout ---------------------------------------------------------------

#[test]
fn opens_and_closes_a_block() {
    assert_eq!(
        kinds("test\n  1\n"),
        vec![Name("test".into()), Newline, Indent, Integer(1), Newline, Dedent, End]
    );
}

#[test]
fn closes_every_open_block_at_the_end_of_the_file() {
    // Three levels open, none closed by a dedent — the file ending has to
    // close all three or the parser sees an unfinished tree.
    let tokens = kinds("a\n  b\n    c\n      d\n");
    let dedents = tokens.iter().filter(|k| **k == Dedent).count();
    assert_eq!(dedents, 3);
}

#[test]
fn emits_one_dedent_per_level_closed_at_once() {
    let tokens = kinds("a\n  b\n    c\nd\n");
    // c is two levels deep; returning to column 0 closes both.
    let after_c: Vec<_> = tokens
        .iter()
        .skip_while(|k| **k != Name("c".into()))
        .collect();
    let dedents = after_c.iter().filter(|k| ***k == Dedent).count();
    assert_eq!(dedents, 2);
}

#[test]
fn a_blank_line_does_not_close_a_block() {
    // The failure this guards: an empty line has no indentation, so a
    // lexer that runs the layout rule on it would dedent out of the
    // block the user is still inside.
    let tokens = kinds("a\n  b\n\n  c\n");
    assert_eq!(
        tokens,
        vec![
            Name("a".into()), Newline,
            Indent,
            Name("b".into()), Newline,
            Name("c".into()), Newline,
            Dedent,
            End,
        ]
    );
}

#[test]
fn a_comment_only_line_does_not_close_a_block() {
    let tokens = kinds("a\n  b\n# note\n  c\n");
    let dedents = tokens.iter().filter(|k| **k == Dedent).count();
    assert_eq!(dedents, 1, "only the end of the file should close the block");
}

#[test]
fn strips_comments_from_the_end_of_a_line() {
    assert_eq!(kinds("1 + 2 # adds"), vec![Integer(1), Plus, Integer(2), Newline, End]);
}

#[test]
fn rejects_tabs_rather_than_guessing_a_width() {
    assert!(error("a\n\tb\n").contains("spaces, not tabs"));
}

#[test]
fn rejects_an_indent_that_matches_no_open_block() {
    // Landing between two levels. Rounding to the nearest is how layout
    // languages get code that reads one way and runs another.
    let message = error("a\n    b\n  c\n");
    assert!(message.contains("does not line up"), "got: {message}");
}

#[test]
fn accepts_any_consistent_indent_width() {
    // The language does not mandate two or four spaces; it mandates that
    // a block keeps the width it opened with.
    assert_eq!(kinds("a\n      b\n").iter().filter(|k| **k == Indent).count(), 1);
}
