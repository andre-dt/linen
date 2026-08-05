// =====================================================================
// syntax/lex.rs — SOURCE TEXT INTO TOKENS.
//
// INDENTATION IS SYNTAX
// ---------------------
// A block is opened by indenting and closed by dedenting, and the lexer
// turns that into Indent/Dedent tokens so the parser never has to look
// at whitespace. The parser then treats a block exactly as it would
// treat braces — the layout rule lives in one place, here, instead of
// being re-derived at every construct that has a body.
//
// The rules, kept deliberately strict:
//
//   * Only spaces indent. A tab is an error, not a silent 4 or 8, because
//     "it looks aligned but is not" is the failure mode this whole design
//     exists to avoid.
//   * A dedent must land on a level that was actually opened. Landing
//     between two levels is an error rather than a guess.
//   * Blank lines and comment-only lines carry no indentation at all:
//     they are skipped before the layout rule ever sees them, so a stray
//     blank line inside a block cannot close it.
// =====================================================================

use crate::token::{Span, Token, TokenKind};

#[derive(Debug, PartialEq)]
pub struct LexError {
    pub message: String,
    pub span: Span,
}

pub fn lex(source: &str) -> Result<Vec<Token>, LexError> {
    Lexer::new(source).run()
}

struct Lexer<'a> {
    source: &'a [u8],
    /// Where the next character comes from.
    at: usize,
    tokens: Vec<Token>,
    /// How many brackets are open — `(` and `[` that have not been
    /// closed.
    ///
    /// While any is open, the layout rule is SUSPENDED: no Newline, no
    /// Indent, no Dedent. An open bracket already says the construct is
    /// unfinished, so a line break inside one carries no meaning, and
    /// indentation inside one is alignment rather than structure.
    ///
    /// It is the one thing layout cannot decide for itself. Eight corners
    /// of a box on one line is the alternative, and that is the line
    /// nobody can read.
    open_brackets: usize,
    /// Indentation widths of the blocks currently open, innermost last.
    /// Starts with 0 — the file's own level, which is never closed.
    levels: Vec<usize>,
}

impl<'a> Lexer<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            open_brackets: 0,
            source: source.as_bytes(),
            at: 0,
            tokens: Vec::new(),
            levels: vec![0],
        }
    }

    fn run(mut self) -> Result<Vec<Token>, LexError> {
        while self.at < self.source.len() {
            self.line()?;
        }

        // A file that ends inside a block still closes it, so the parser
        // sees a well-formed tree rather than having to treat EOF as an
        // implicit terminator at every level.
        if !matches!(self.tokens.last().map(|t| &t.kind), None | Some(TokenKind::Newline)) {
            self.push(TokenKind::Newline, self.at, self.at);
        }
        while self.levels.len() > 1 {
            self.levels.pop();
            self.push(TokenKind::Dedent, self.at, self.at);
        }
        self.push(TokenKind::End, self.at, self.at);
        Ok(self.tokens)
    }

    /// One logical line: its indentation, then its tokens, then the
    /// newline. Blank and comment-only lines are consumed without
    /// emitting anything at all.
    fn line(&mut self) -> Result<(), LexError> {
        let indent_start = self.at;
        let width = self.measure_indent()?;


        // Nothing on this line: no layout, no tokens. Checked BEFORE the
        // indent rule so that a blank line inside a block — which has no
        // indentation to speak of — cannot close it.
        if self.at_line_end() {
            self.skip_to_next_line();
            return Ok(());
        }

        self.apply_layout(width, indent_start)?;

        // Tokens until the line ends — or, while a bracket is open,
        // straight past the end of the line and on through the next.
        // The logical line finishes when the brackets are balanced
        // again, so the Newline lands where the CONSTRUCT ends rather
        // than where the text happens to wrap.
        loop {
            while !self.at_line_end() {
                self.token()?;
                self.skip_spaces();
            }
            if self.open_brackets == 0 || self.at >= self.source.len() {
                break;
            }
            self.skip_to_next_line();
            self.measure_indent()?;
        }

        self.push(TokenKind::Newline, self.at, self.at);
        self.skip_to_next_line();
        Ok(())
    }

    /// Counts the leading spaces, rejecting tabs.
    fn measure_indent(&mut self) -> Result<usize, LexError> {
        let start = self.at;
        let mut width = 0;
        while let Some(byte) = self.peek() {
            match byte {
                b' ' => {
                    width += 1;
                    self.at += 1;
                }
                b'\t' => {
                    return Err(LexError {
                        message: "indent with spaces, not tabs".to_string(),
                        span: Span::new(self.at, self.at + 1),
                    });
                }
                _ => break,
            }
        }
        let _ = start;
        Ok(width)
    }

    /// Turns a change in indentation into Indent/Dedent tokens.
    fn apply_layout(&mut self, width: usize, at: usize) -> Result<(), LexError> {
        let current = *self.levels.last().expect("level 0 is never popped");

        if width > current {
            self.levels.push(width);
            self.push(TokenKind::Indent, at, self.at);
            return Ok(());
        }

        // Closing one level per step, so three levels closing at once
        // emit three Dedents and the parser can pop three blocks.
        while width < *self.levels.last().expect("level 0 is never popped") {
            self.levels.pop();
            self.push(TokenKind::Dedent, at, self.at);
        }

        // Landing between two open levels means the line is indented to a
        // width nobody opened. Silently rounding it to the nearest is how
        // layout languages get code that reads one way and runs another.
        if width != *self.levels.last().expect("level 0 is never popped") {
            return Err(LexError {
                message: format!(
                    "this line is indented {width} spaces, which does not line up with any open block"
                ),
                span: Span::new(at, self.at),
            });
        }
        Ok(())
    }

    fn token(&mut self) -> Result<(), LexError> {
        let start = self.at;
        let byte = self.peek().expect("caller checked the line is not over");

        match byte {
            b'0'..=b'9' => self.number(start),
            b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                self.name(start);
                Ok(())
            }
            b'"' => self.text(start, b'"'),
            b'\'' => self.text(start, b'\''),
            _ => self.punctuation(start),
        }
    }

    fn number(&mut self, start: usize) -> Result<(), LexError> {
        while matches!(self.peek(), Some(b'0'..=b'9' | b'_')) {
            self.at += 1;
        }
        let text: String = self.slice(start, self.at).chars().filter(|c| *c != '_').collect();
        let value = text.parse::<i64>().map_err(|_| LexError {
            message: format!("`{text}` does not fit in a 64-bit integer"),
            span: Span::new(start, self.at),
        })?;
        self.push(TokenKind::Integer(value), start, self.at);
        Ok(())
    }

    fn name(&mut self, start: usize) {
        while matches!(self.peek(), Some(b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_')) {
            self.at += 1;
        }
        let text = self.slice(start, self.at).to_string();
        self.push(TokenKind::Name(text), start, self.at);
    }

    /// A quoted string, in either quote.
    ///
    /// Double quotes for prose — test names, throw messages. Single
    /// quotes for module paths, which is what `from './brep'` writes.
    /// The distinction is only convention; both produce the same token,
    /// and the parser knows which it is by where it appears.
    fn text(&mut self, start: usize, quote: u8) -> Result<(), LexError> {
        self.at += 1; // the opening quote
        let content_start = self.at;
        loop {
            match self.peek() {
                // A newline inside a string is almost always a missing
                // closing quote, and reporting it here points at the line
                // that opened it instead of somewhere far below.
                None | Some(b'\n') => {
                    return Err(LexError {
                        message: "this text is missing its closing quote".to_string(),
                        span: Span::new(start, self.at),
                    });
                }
                Some(byte) if byte == quote => break,
                _ => self.at += 1,
            }
        }
        let content = self.slice(content_start, self.at).to_string();
        self.at += 1; // the closing quote
        self.push(TokenKind::Text(content), start, self.at);
        Ok(())
    }

    fn punctuation(&mut self, start: usize) -> Result<(), LexError> {
        let byte = self.source[self.at];
        self.at += 1;

        // Two-character operators are checked first: seeing `=` and
        // stopping would make `==` lex as two tokens.
        let kind = match (byte, self.peek()) {
            (b'=', Some(b'=')) => {
                self.at += 1;
                TokenKind::EqualEqual
            }
            (b'!', Some(b'=')) => {
                self.at += 1;
                TokenKind::BangEqual
            }
            (b'<', Some(b'=')) => {
                self.at += 1;
                TokenKind::LessEqual
            }
            (b'>', Some(b'=')) => {
                self.at += 1;
                TokenKind::GreaterEqual
            }
            (b'+', _) => TokenKind::Plus,
            (b'-', _) => TokenKind::Minus,
            (b'*', _) => TokenKind::Star,
            (b'/', _) => TokenKind::Slash,
            (b'%', _) => TokenKind::Percent,
            (b'<', _) => TokenKind::Less,
            (b'>', _) => TokenKind::Greater,
            (b'(', _) => {
                self.open_brackets += 1;
                TokenKind::LeftParen
            }
            (b')', _) => {
                // Saturating, so a stray `)` cannot wrap the counter and
                // silently disable layout for the rest of the file. The
                // parser reports the mismatch; the lexer just stays sane.
                self.open_brackets = self.open_brackets.saturating_sub(1);
                TokenKind::RightParen
            }
            (b',', _) => TokenKind::Comma,
            // `=` binds a name; `==` compares. Checked after the
            // two-character forms above, so `==` never lexes as two of
            // these.
            (b'=', _) => TokenKind::Equal,
            (b'.', Some(b'.')) => {
                self.at += 1;
                TokenKind::DotDot
            }
            (b'.', _) => TokenKind::Dot,
            (b':', _) => TokenKind::Colon,
            (b';', _) => TokenKind::Semicolon,
            (b'[', _) => {
                self.open_brackets += 1;
                TokenKind::LeftBracket
            }
            (b']', _) => {
                self.open_brackets = self.open_brackets.saturating_sub(1);
                TokenKind::RightBracket
            }
            (other, _) => {
                return Err(LexError {
                    message: format!("`{}` is not part of the language", other as char),
                    span: Span::new(start, self.at),
                });
            }
        };
        self.push(kind, start, self.at);
        Ok(())
    }

    // --- moving through the source ----------------------------------------

    fn peek(&self) -> Option<u8> {
        self.source.get(self.at).copied()
    }

    fn slice(&self, start: usize, end: usize) -> &str {
        std::str::from_utf8(&self.source[start..end]).expect("sliced on token boundaries")
    }

    fn skip_spaces(&mut self) {
        while matches!(self.peek(), Some(b' ')) {
            self.at += 1;
        }
    }

    /// True at the end of the line's CONTENT — a comment counts as the
    /// end, so `# ...` never reaches the parser.
    fn at_line_end(&self) -> bool {
        matches!(self.peek(), None | Some(b'\n') | Some(b'\r') | Some(b'#'))
    }

    fn skip_to_next_line(&mut self) {
        while !matches!(self.peek(), None | Some(b'\n')) {
            self.at += 1;
        }
        if self.peek() == Some(b'\n') {
            self.at += 1;
        }
    }

    fn push(&mut self, kind: TokenKind, start: usize, end: usize) {
        self.tokens.push(Token { kind, span: Span::new(start, end) });
    }
}
