// =====================================================================
// syntax/token.rs — WHAT THE LEXER PRODUCES.
//
// The token stream is the parser's whole input, so everything the parser
// needs to report a good error has to survive here: every token carries
// the byte range it came from, and nothing is discarded silently.
// =====================================================================

/// Where a token sits in the source, as a byte range.
///
/// Byte offsets rather than line/column: they are cheap to carry and
/// exact, and line/column is derivable from them when a message is
/// actually printed. Storing the derived form instead would mean
/// computing it for every token, including the thousands never involved
/// in an error.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    /// The span covering both, for an error about a whole construct
    /// rather than one of its tokens.
    pub fn to(self, other: Span) -> Span {
        Span::new(self.start.min(other.start), self.end.max(other.end))
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct Token {
    pub kind: TokenKind,
    pub span: Span,
}

#[derive(Clone, PartialEq, Debug)]
pub enum TokenKind {
    // --- literals and names ---------------------------------------------
    /// An integer literal, already parsed. The source text stays
    /// reachable through the span if a diagnostic needs to quote it.
    Integer(i64),
    /// An identifier, or a keyword — the parser decides which, because
    /// `test` is a keyword at the start of a statement and a perfectly
    /// good variable name elsewhere. Deciding here would make the lexer
    /// need a parser's context.
    Name(String),
    /// A quoted string. Only test names use these today.
    Text(String),

    // --- punctuation ------------------------------------------------------
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Equal,
    EqualEqual,
    BangEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    LeftParen,
    RightParen,
    Comma,

    // --- layout -----------------------------------------------------------
    // Indentation is syntax, so it arrives as tokens rather than as a
    // property the parser has to inspect. That is what lets the parser
    // stay a plain recursive-descent over a flat stream: a block is
    // Indent … Dedent, exactly as braces would be.
    /// End of a logical line.
    Newline,
    /// A block opened: the line is indented deeper than the one before.
    Indent,
    /// A block closed. One per level, so closing three levels at once
    /// emits three.
    Dedent,
    /// End of input. Always the last token, so the parser has something
    /// to stop on without checking bounds.
    End,
}

impl TokenKind {
    /// How this token reads in a message, for "expected X, found Y".
    pub fn describe(&self) -> String {
        match self {
            TokenKind::Integer(value) => format!("the number {value}"),
            TokenKind::Name(name) => format!("`{name}`"),
            TokenKind::Text(_) => "a text literal".to_string(),
            TokenKind::Plus => "`+`".to_string(),
            TokenKind::Minus => "`-`".to_string(),
            TokenKind::Star => "`*`".to_string(),
            TokenKind::Slash => "`/`".to_string(),
            TokenKind::Percent => "`%`".to_string(),
            TokenKind::Equal => "`=`".to_string(),
            TokenKind::EqualEqual => "`==`".to_string(),
            TokenKind::BangEqual => "`!=`".to_string(),
            TokenKind::Less => "`<`".to_string(),
            TokenKind::LessEqual => "`<=`".to_string(),
            TokenKind::Greater => "`>`".to_string(),
            TokenKind::GreaterEqual => "`>=`".to_string(),
            TokenKind::LeftParen => "`(`".to_string(),
            TokenKind::RightParen => "`)`".to_string(),
            TokenKind::Comma => "`,`".to_string(),
            TokenKind::Newline => "the end of the line".to_string(),
            TokenKind::Indent => "an indented block".to_string(),
            TokenKind::Dedent => "the end of a block".to_string(),
            TokenKind::End => "the end of the file".to_string(),
        }
    }
}
