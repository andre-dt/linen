// =====================================================================
// syntax/parse.rs — TOKENS INTO A TREE.
//
// Plain recursive descent. The layout rule already became Indent/Dedent
// tokens in the lexer, so a block here is `expect(Indent) … expect(Dedent)`
// and reads exactly as it would in a language with braces — the whole
// point of doing layout in the lexer.
//
// Binary operators use precedence climbing rather than one function per
// level. Twelve operators would be five near-identical functions
// otherwise, and every new operator would mean editing the chain in the
// right place; here it means adding a line to `precedence()`.
//
// ERRORS STOP AT THE FIRST ONE
// ----------------------------
// No recovery, no error cascades. A parser that guesses its way past a
// syntax error reports five failures for one mistake, and four of them
// are fiction. One real error the user can act on beats a list.
// =====================================================================

use crate::ast::*;
use crate::token::{Span, Token, TokenKind};

#[derive(Debug, PartialEq)]
pub struct ParseError {
    pub message: String,
    pub span: Span,
}

pub fn parse(tokens: &[Token]) -> Result<Unit, ParseError> {
    Parser { tokens, at: 0 }.unit()
}

struct Parser<'a> {
    tokens: &'a [Token],
    at: usize,
}

impl<'a> Parser<'a> {
    // --- the top level ----------------------------------------------------

    fn unit(&mut self) -> Result<Unit, ParseError> {
        let mut items = Vec::new();
        loop {
            self.skip_newlines();
            if self.check(&TokenKind::End) {
                break;
            }
            items.push(self.item()?);
        }
        Ok(Unit { items })
    }

    fn item(&mut self) -> Result<Item, ParseError> {
        match self.peek_name() {
            Some("fn") => Ok(Item::Function(self.function()?)),
            Some("test") => Ok(Item::Test(self.test()?)),
            _ => Err(self.error_here("expected `fn` or `test` at the top level")),
        }
    }

    fn function(&mut self) -> Result<Function, ParseError> {
        let start = self.span_here();
        self.advance(); // fn
        let name = self.name("a function name")?;

        self.expect(&TokenKind::LeftParen, "`(` after the function name")?;
        let mut parameters = Vec::new();
        while !self.check(&TokenKind::RightParen) {
            parameters.push(self.parameter()?);
            if !self.take(&TokenKind::Comma) {
                break;
            }
        }
        self.expect(&TokenKind::RightParen, "`)` to close the parameter list")?;

        // The return type, if there is one. Written bare after the
        // parameters — no arrow, no colon. Its absence means the function
        // returns nothing.
        let result = if self.check(&TokenKind::Newline) {
            None
        } else {
            Some(self.type_name()?)
        };

        let body = self.block()?;
        let span = start.to(self.span_before());
        Ok(Function { name, parameters, result, body, span })
    }

    fn parameter(&mut self) -> Result<Parameter, ParseError> {
        let start = self.span_here();
        let name = self.name("a parameter name")?;
        let type_name = self.type_name()?;
        Ok(Parameter { name, type_name, span: start.to(self.span_before()) })
    }

    fn type_name(&mut self) -> Result<TypeName, ParseError> {
        let span = self.span_here();
        let name = self.name("a type")?;
        Ok(TypeName { name, span })
    }

    fn test(&mut self) -> Result<Test, ParseError> {
        let start = self.span_here();
        self.advance(); // test

        let name = match &self.peek().kind {
            TokenKind::Text(text) => {
                let text = text.clone();
                self.advance();
                text
            }
            // Naming a test with a bare identifier is the obvious slip,
            // so it gets its own message rather than "expected a text
            // literal".
            _ => {
                return Err(self.error_here(
                    "a test is named with quoted text, as in `test \"adds two numbers\"`",
                ))
            }
        };

        let body = self.block()?;
        let span = start.to(self.span_before());
        Ok(Test { name, body, span })
    }

    // --- blocks and statements --------------------------------------------

    /// `Newline Indent statement+ Dedent` — the shape every body takes.
    fn block(&mut self) -> Result<Vec<Statement>, ParseError> {
        self.expect(&TokenKind::Newline, "a line break before the body")?;
        self.expect(&TokenKind::Indent, "an indented body")?;

        let mut statements = Vec::new();
        loop {
            self.skip_newlines();
            if self.check(&TokenKind::Dedent) {
                break;
            }
            // A body that runs into the end of the file is a missing
            // Dedent, which the lexer only emits for real input. Guarding
            // here turns a would-be infinite loop into a message.
            if self.check(&TokenKind::End) {
                return Err(self.error_here("this block is never closed"));
            }
            statements.push(self.statement()?);
        }
        self.advance(); // Dedent

        if statements.is_empty() {
            return Err(self.error_here("this block is empty"));
        }
        Ok(statements)
    }

    fn statement(&mut self) -> Result<Statement, ParseError> {
        let statement = match self.peek_name() {
            Some("let") => self.let_statement()?,
            Some("return") => self.return_statement()?,
            Some("assert") => self.assert_statement()?,
            _ => return Err(self.error_here("expected `let`, `return` or `assert`")),
        };
        self.expect(&TokenKind::Newline, "a line break after the statement")?;
        Ok(statement)
    }

    fn let_statement(&mut self) -> Result<Statement, ParseError> {
        let start = self.span_here();
        self.advance(); // let
        let name = self.name("a name to bind")?;

        self.expect(&TokenKind::Equal, "`=` after the name")?;

        let value = self.expression()?;
        let span = start.to(value.span());
        Ok(Statement::Let { name, value, span })
    }

    fn return_statement(&mut self) -> Result<Statement, ParseError> {
        let start = self.span_here();
        self.advance(); // return
        let value = if self.check(&TokenKind::Newline) {
            None
        } else {
            Some(self.expression()?)
        };
        let span = start.to(self.span_before());
        Ok(Statement::Return { value, span })
    }

    fn assert_statement(&mut self) -> Result<Statement, ParseError> {
        let start = self.span_here();
        self.advance(); // assert
        self.expect(&TokenKind::LeftParen, "`(` after `assert`")?;
        let condition = self.expression()?;
        self.expect(&TokenKind::RightParen, "`)` to close the assert")?;
        let span = start.to(self.span_before());
        Ok(Statement::Assert { condition, span })
    }

    // --- expressions ------------------------------------------------------

    fn expression(&mut self) -> Result<Expression, ParseError> {
        self.binary(0)
    }

    /// Precedence climbing: parse a operand, then keep absorbing
    /// operators that bind at least as tightly as `floor`.
    fn binary(&mut self, floor: u8) -> Result<Expression, ParseError> {
        let mut left = self.unary()?;

        while let Some(operator) = self.peek_operator() {
            let precedence = operator.precedence();
            if precedence < floor {
                break;
            }
            self.advance();
            // `precedence + 1` makes every operator left-associative:
            // `a - b - c` is `(a - b) - c`, not `a - (b - c)`.
            let right = self.binary(precedence + 1)?;
            let span = left.span().to(right.span());
            left = Expression::Binary {
                operator,
                left: Box::new(left),
                right: Box::new(right),
                span,
            };
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Expression, ParseError> {
        if self.check(&TokenKind::Minus) {
            let start = self.span_here();
            self.advance();
            let operand = self.unary()?;
            let span = start.to(operand.span());
            return Ok(Expression::Unary {
                operator: UnaryOperator::Negate,
                operand: Box::new(operand),
                span,
            });
        }
        self.primary()
    }

    fn primary(&mut self) -> Result<Expression, ParseError> {
        let span = self.span_here();
        match self.peek().kind.clone() {
            TokenKind::Integer(value) => {
                self.advance();
                Ok(Expression::Integer { value, span })
            }
            TokenKind::LeftParen => {
                self.advance();
                let inner = self.expression()?;
                self.expect(&TokenKind::RightParen, "`)` to close the group")?;
                Ok(inner)
            }
            TokenKind::Name(name) => {
                self.advance();
                if self.take(&TokenKind::LeftParen) {
                    let mut arguments = Vec::new();
                    while !self.check(&TokenKind::RightParen) {
                        arguments.push(self.expression()?);
                        if !self.take(&TokenKind::Comma) {
                            break;
                        }
                    }
                    self.expect(&TokenKind::RightParen, "`)` to close the arguments")?;
                    let span = span.to(self.span_before());
                    return Ok(Expression::Call { callee: name, arguments, span });
                }
                Ok(Expression::Name { name, span })
            }
            _ => Err(self.error_here("expected a value")),
        }
    }

    fn peek_operator(&self) -> Option<BinaryOperator> {
        Some(match self.peek().kind {
            TokenKind::Plus => BinaryOperator::Add,
            TokenKind::Minus => BinaryOperator::Subtract,
            TokenKind::Star => BinaryOperator::Multiply,
            TokenKind::Slash => BinaryOperator::Divide,
            TokenKind::Percent => BinaryOperator::Remainder,
            TokenKind::EqualEqual => BinaryOperator::Equal,
            TokenKind::BangEqual => BinaryOperator::NotEqual,
            TokenKind::Less => BinaryOperator::Less,
            TokenKind::LessEqual => BinaryOperator::LessOrEqual,
            TokenKind::Greater => BinaryOperator::Greater,
            TokenKind::GreaterEqual => BinaryOperator::GreaterOrEqual,
            _ => return None,
        })
    }

    // --- moving through the stream ----------------------------------------

    fn peek(&self) -> &Token {
        // The lexer always ends with `End`, so there is nothing past it
        // to index into.
        &self.tokens[self.at.min(self.tokens.len() - 1)]
    }

    fn peek_name(&self) -> Option<&str> {
        match &self.peek().kind {
            TokenKind::Name(name) => Some(name),
            _ => None,
        }
    }

    fn span_here(&self) -> Span {
        self.peek().span
    }

    fn span_before(&self) -> Span {
        self.tokens[self.at.saturating_sub(1).min(self.tokens.len() - 1)].span
    }

    fn advance(&mut self) {
        if self.at < self.tokens.len() - 1 {
            self.at += 1;
        }
    }

    fn check(&self, kind: &TokenKind) -> bool {
        &self.peek().kind == kind
    }

    /// Consumes the token if it matches, and says whether it did.
    fn take(&mut self, kind: &TokenKind) -> bool {
        if self.check(kind) {
            self.advance();
            return true;
        }
        false
    }

    fn expect(&mut self, kind: &TokenKind, what: &str) -> Result<(), ParseError> {
        if self.take(kind) {
            return Ok(());
        }
        Err(self.error_here(&format!("expected {what}")))
    }

    fn name(&mut self, what: &str) -> Result<String, ParseError> {
        match &self.peek().kind {
            TokenKind::Name(name) => {
                let name = name.clone();
                self.advance();
                Ok(name)
            }
            _ => Err(self.error_here(&format!("expected {what}"))),
        }
    }

    fn skip_newlines(&mut self) {
        while self.check(&TokenKind::Newline) {
            self.advance();
        }
    }

    /// Always says what was FOUND alongside what was wanted. "expected
    /// `)`" alone leaves the user hunting; "expected `)`, found the end
    /// of the line" points at the mistake.
    fn error_here(&self, message: &str) -> ParseError {
        ParseError {
            message: format!("{message}, found {}", self.peek().kind.describe()),
            span: self.span_here(),
        }
    }
}
