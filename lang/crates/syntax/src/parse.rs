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

    /// PascalCase names a shape, snake_case names a function.
    ///
    /// The case is grammar here, not convention. It is what lets
    /// `Point(x: 1)` and `add(a: 1)` be told apart at the first token
    /// instead of by looking ahead for a `:` — and, being checked, it is
    /// something a reader can rely on rather than hope for.
    fn starts_uppercase(name: &str) -> bool {
        name.chars().next().is_some_and(|first| first.is_ascii_uppercase())
    }

    fn item(&mut self) -> Result<Item, ParseError> {
        // `export fn` — the only thing `export` may precede. A shape is
        // reachable through an exported signature or not at all, and a
        // test is never part of a boundary.
        if self.peek_name() == Some("export") {
            self.advance();
            if self.peek_name() != Some("fn") {
                return Err(self.error_here("expected `fn` after `export`"));
            }
            return Ok(Item::Function(self.function(true, false)?));
        }

        // `driver fn` — a signature bound to Rust. Not combinable with
        // `export`: one says what crosses INTO the language, the other
        // what crosses out, and a function cannot be both.
        if self.peek_name() == Some("driver") {
            self.advance();
            if self.peek_name() != Some("fn") {
                return Err(self.error_here("expected `fn` after `driver`"));
            }
            return Ok(Item::Function(self.function(false, true)?));
        }
        match self.peek_name() {
            Some("from") => Ok(Item::Import(self.import()?)),
            Some("fn") => Ok(Item::Function(self.function(false, false)?)),
            Some("shape") => Ok(Item::Shape(self.shape()?)),
            Some("test") => Ok(Item::Test(self.test()?)),
            _ => Err(self.error_here(
                "expected `from`, `fn`, `export fn`, `driver fn`, `shape` or `test` at the top level",
            )),
        }
    }

    fn function(&mut self, exported: bool, driver: bool) -> Result<Function, ParseError> {
        let start = self.span_here();
        self.advance(); // fn
        let name_span = self.span_here();
        let name = self.name("a function name")?;
        if Self::starts_uppercase(&name) {
            return Err(ParseError {
                message: format!(
                    "`{name}` starts with a capital, which names a shape; a function is written in snake_case"
                ),
                span: name_span,
            });
        }
        let generics = self.generic_parameters()?;

        self.expect(&TokenKind::LeftParen, "`(` after the function name")?;
        let mut parameters = Vec::new();
        while !self.check(&TokenKind::RightParen) {
            parameters.push(self.parameter()?);
            if !self.take(&TokenKind::Comma) {
                break;
            }
        }
        self.expect(&TokenKind::RightParen, "`)` to close the parameter list")?;

        if let Some(late) = Self::required_come_first(&parameters) {
            return Err(ParseError {
                message: format!(
                    "`{}` has no default, so it must come before the parameters that do",
                    late.name
                ),
                span: late.span,
            });
        }

        // The return type, if there is one. Written bare after the
        // parameters — no arrow, no colon. Its absence means the function
        // returns nothing.
        let result = if self.check(&TokenKind::Newline) {
            None
        } else {
            Some(self.type_name()?)
        };

        // A driver ends at its signature: the body is Rust, and there is
        // nothing here to write. Everything else needs one.
        let body = if driver {
            self.expect(&TokenKind::Newline, "a line break after the driver signature")?;
            // An indented block after the signature is the obvious slip,
            // and it deserves its own message: the generic one talks
            // about the top level, which does not explain why a body is
            // wrong HERE.
            if self.check(&TokenKind::Indent) {
                return Err(self.error_here(
                    "a driver has no body — the implementation is Rust, bound at link time",
                ));
            }
            Vec::new()
        } else {
            self.block()?
        };
        let span = start.to(self.span_before());
        Ok(Function { name, exported, driver, generics, parameters, result, body, span })
    }

    fn parameter(&mut self) -> Result<Parameter, ParseError> {
        let start = self.span_here();
        let name = self.name("a parameter name")?;
        let type_name = self.type_name()?;
        // `= value` makes it optional. Nothing else does — there is no
        // separate marker to also keep in sync.
        let default = if self.take(&TokenKind::Equal) {
            Some(self.expression()?)
        } else {
            None
        };
        Ok(Parameter { name, type_name, default, span: start.to(self.span_before()) })
    }

    /// Required parameters come before optional ones.
    ///
    /// Arguments are given in declaration order, so an optional one in the
    /// middle could only be skipped by leaving a hole — and there is no
    /// notation for a hole. Requiring the order at the DECLARATION means
    /// every call site is writable; allowing it and then rejecting calls
    /// would move the error away from the mistake.
    fn required_come_first(parameters: &[Parameter]) -> Option<&Parameter> {
        let first_optional = parameters.iter().position(|p| p.default.is_some())?;
        parameters[first_optional..].iter().find(|p| p.default.is_none())
    }

    /// The same rule for shape fields, since a construction is written
    /// like a call and skips omitted values the same way.
    fn fields_required_come_first(fields: &[Field]) -> Option<&Field> {
        let first_optional = fields.iter().position(|f| f.default.is_some())?;
        fields[first_optional..].iter().find(|f| f.default.is_none())
    }

    /// `shape Name` with its fields indented under it.
    fn shape(&mut self) -> Result<Shape, ParseError> {
        let start = self.span_here();
        self.advance(); // shape
        let name_span = self.span_here();
        let name = self.name("a shape name")?;
        if !Self::starts_uppercase(&name) {
            return Err(ParseError {
                message: format!(
                    "`{name}` starts lowercase, which names a function; a shape is written in PascalCase"
                ),
                span: name_span,
            });
        }
        let generics = self.generic_parameters()?;

        self.expect(&TokenKind::Newline, "a line break before the fields")?;
        self.expect(&TokenKind::Indent, "the fields, indented")?;

        let mut fields = Vec::new();
        loop {
            self.skip_newlines();
            if self.check(&TokenKind::Dedent) {
                break;
            }
            if self.check(&TokenKind::End) {
                return Err(self.error_here("this shape is never closed"));
            }
            let field_start = self.span_here();
            let field_name = self.name("a field name")?;
            let type_name = self.type_name()?;
            let default = if self.take(&TokenKind::Equal) {
                Some(self.expression()?)
            } else {
                None
            };
            self.expect(&TokenKind::Newline, "a line break after the field")?;
            fields.push(Field {
                name: field_name,
                type_name,
                default,
                span: field_start.to(self.span_before()),
            });
        }
        self.advance(); // Dedent

        if fields.is_empty() {
            return Err(self.error_here("a shape needs at least one field"));
        }
        if let Some(late) = Self::fields_required_come_first(&fields) {
            return Err(ParseError {
                message: format!(
                    "`{}` has no default, so it must come before the fields that do",
                    late.name
                ),
                span: late.span,
            });
        }
        Ok(Shape { name, generics, fields, span: start.to(self.span_before()) })
    }

    /// `<T, U>` after a name, or nothing.
    fn generic_parameters(&mut self) -> Result<Vec<GenericParameter>, ParseError> {
        if !self.check(&TokenKind::Less) {
            return Ok(Vec::new());
        }
        self.advance(); // <

        let mut generics = Vec::new();
        loop {
            let span = self.span_here();
            let name = self.name("a type parameter")?;
            generics.push(GenericParameter { name, span });
            if !self.take(&TokenKind::Comma) {
                break;
            }
        }
        self.expect(&TokenKind::Greater, "`>` to close the type parameters")?;
        Ok(generics)
    }

    /// A type as written: `i32`, `List<i32>`, `[i32; 3]`.
    fn type_name(&mut self) -> Result<TypeName, ParseError> {
        let span = self.span_here();

        // `[element; size]` — a fixed-size array. The size is part of the
        // type, which is what lets the value live without an allocation.
        if self.take(&TokenKind::LeftBracket) {
            let element = self.type_name()?;
            self.expect(&TokenKind::Semicolon, "`;` between the element type and the size")?;
            let size = match self.peek().kind {
                TokenKind::Integer(value) => {
                    self.advance();
                    value
                }
                _ => return Err(self.error_here("expected the array size, as a number")),
            };
            self.expect(&TokenKind::RightBracket, "`]` to close the array type")?;
            return Ok(TypeName {
                name: element.name.clone(),
                arguments: vec![element],
                array_size: Some(size),
                span: span.to(self.span_before()),
            });
        }

        let name = self.name("a type")?;

        // `List<i32>` — arguments applied to the name.
        let mut arguments = Vec::new();
        if self.check(&TokenKind::Less) {
            self.advance();
            loop {
                arguments.push(self.type_name()?);
                if !self.take(&TokenKind::Comma) {
                    break;
                }
            }
            self.expect(&TokenKind::Greater, "`>` to close the type arguments")?;
        }

        Ok(TypeName {
            name,
            arguments,
            array_size: None,
            span: span.to(self.span_before()),
        })
    }

    /// `from './brep' use Vertex, Edge, Body`
    ///
    /// One line, no block, so it ends at the newline. The path comes
    /// first because that is the order the question is asked in — where
    /// from, then what.
    fn import(&mut self) -> Result<Import, ParseError> {
        let start = self.span_here();
        self.advance(); // from

        let path = match &self.peek().kind {
            TokenKind::Text(text) => {
                let text = text.clone();
                self.advance();
                text
            }
            _ => {
                return Err(self.error_here(
                    "a module path is quoted, as in `from './brep' use Vertex`",
                ))
            }
        };

        if self.peek_name() != Some("use") {
            return Err(self.error_here(
                "`from` names what it takes, as in `from './brep' use Vertex, Edge`",
            ));
        }
        self.advance(); // use

        let mut names = Vec::new();
        loop {
            let span = self.span_here();
            let TokenKind::Name(name) = &self.peek().kind else {
                return Err(self.error_here("expected a name to import"));
            };
            names.push(ImportedName { name: name.clone(), span });
            self.advance();

            if matches!(self.peek().kind, TokenKind::Comma) {
                self.advance();
                continue;
            }
            break;
        }

        self.expect(&TokenKind::Newline, "a line break after the import")?;
        let span = start.to(self.span_before());
        Ok(Import { path, names, span })
    }

    fn test(&mut self) -> Result<Test, ParseError> {
        let start = self.span_here();
        self.advance(); // test

        // `draws` sits between `test` and the name: the modifier reads
        // as part of the sentence rather than as a separate declaration.
        let draws = self.peek_name() == Some("draws");
        if draws {
            self.advance();
        }

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
        Ok(Test { name, draws, body, span })
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
        // The block-bodied statements consume their own terminator — a
        // block already ends on a Dedent — so they return early rather
        // than falling through to the newline check below.
        match self.peek_name() {
            Some("if") => return self.if_statement(),
            Some("while") => return self.while_statement(),
            Some("for") => return self.for_statement(),
            _ => {}
        }

        let statement = match self.peek_name() {
            Some("solid") => self.mesh_statement(MeshKind::Solid)?,
            Some("wire") => self.mesh_statement(MeshKind::Wire)?,
            Some("let") => self.let_statement()?,
            Some("return") => self.return_statement()?,
            Some("throw") => self.throw_statement()?,
            // A call written for its effect. Checked last, so a keyword
            // is never mistaken for a function name.
            Some(_) if self.starts_a_call() => self.call_statement()?,
            _ => {
                return Err(self.error_here(
                    "expected `let`, `return`, `throw`, `solid`, `wire`, `if`, `while` or `for`",
                ))
            }
        };
        self.expect(&TokenKind::Newline, "a line break after the statement")?;
        Ok(statement)
    }

    /// `if condition <block>` with an optional `else`.
    ///
    /// The statement form. The expression form lives in `primary`, and
    /// the two differ in exactly one way: there, `else` is required,
    /// because a value has to exist on both paths.
    fn if_statement(&mut self) -> Result<Statement, ParseError> {
        let start = self.span_here();
        self.advance(); // if
        let condition = self.expression()?;
        let then_branch = self.block()?;

        let else_branch = if self.peek_name() == Some("else") {
            self.advance();
            Some(self.block()?)
        } else {
            None
        };

        let span = start.to(self.span_before());
        Ok(Statement::If { condition, then_branch, else_branch, span })
    }

    fn while_statement(&mut self) -> Result<Statement, ParseError> {
        let start = self.span_here();
        self.advance(); // while
        let condition = self.expression()?;
        let body = self.block()?;
        let span = start.to(self.span_before());
        Ok(Statement::While { condition, body, span })
    }

    /// `for name in start .. end <block>`
    ///
    /// A half-open range: `0 .. 3` visits 0, 1 and 2. Half-open because
    /// `0 .. n` then means "n times", which is the thing people write,
    /// and because adjacent ranges meet without overlapping.
    fn for_statement(&mut self) -> Result<Statement, ParseError> {
        let start_span = self.span_here();
        self.advance(); // for
        // Checked before reading the name: `for in 0 .. 3` would
        // otherwise take `in` AS the name and then complain that `in` is
        // missing, which points at the wrong thing entirely.
        if self.peek_name() == Some("in") {
            return Err(self.error_here("expected a name for the loop variable"));
        }
        let name = self.name("a name for the loop variable")?;

        if self.peek_name() != Some("in") {
            return Err(self.error_here("expected `in` after the loop variable"));
        }
        self.advance();

        let start = self.expression()?;
        self.expect(&TokenKind::DotDot, "`..` between the start and end of the range")?;
        let end = self.expression()?;
        let body = self.block()?;

        let span = start_span.to(self.span_before());
        Ok(Statement::For { name, start, end, body, span })
    }

    /// `solid(points: …, triangles: …)`
    fn mesh_statement(&mut self, kind: MeshKind) -> Result<Statement, ParseError> {
        let start = self.span_here();
        self.advance(); // solid / wire
        self.expect(&TokenKind::LeftParen, "`(` after the geometry")?;
        let arguments = self.named_arguments("argument")?;
        Ok(Statement::Solid { arguments, kind, span: start.to(self.span_before()) })
    }

    /// Whether the statement here is `name(` — a call, and not the
    /// start of anything else a statement can be.
    fn starts_a_call(&self) -> bool {
        matches!(self.peek().kind, TokenKind::Name(_))
            && matches!(self.peek_at(1).kind, TokenKind::LeftParen)
    }

    /// A call whose result is thrown away.
    fn call_statement(&mut self) -> Result<Statement, ParseError> {
        let start = self.span_here();
        let call = self.expression()?;
        if !matches!(call, Expression::Call { .. }) {
            return Err(ParseError {
                message: "only a call can stand alone as a statement".to_string(),
                span: start.to(self.span_before()),
            });
        }
        Ok(Statement::Call { call, span: start.to(self.span_before()) })
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

    fn throw_statement(&mut self) -> Result<Statement, ParseError> {
        let start = self.span_here();
        self.advance(); // throw

        let message = match &self.peek().kind {
            TokenKind::Text(text) => {
                let text = text.clone();
                self.advance();
                text
            }
            _ => {
                return Err(self.error_here(
                    "expected the message to throw, as quoted text",
                ))
            }
        };

        let sense = match self.peek_name() {
            Some("if") => ThrowSense::When,
            Some("unless") => ThrowSense::Unless,
            _ => {
                return Err(self.error_here(
                    "expected `if` or `unless` after the message",
                ))
            }
        };
        self.advance();

        let condition = self.expression()?;
        let span = start.to(condition.span());
        Ok(Statement::Throw { message, sense, condition, span })
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
        if self.peek_name() == Some("not") {
            let start = self.span_here();
            self.advance();
            let operand = self.unary()?;
            let span = start.to(operand.span());
            return Ok(Expression::Unary {
                operator: UnaryOperator::Not,
                operand: Box::new(operand),
                span,
            });
        }
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
        self.postfix()
    }

    /// A value, then any number of `.field` and `[index]` after it.
    ///
    /// Left-associative by construction: `a.b.c` reads a, then .b, then
    /// .c, which is the only grouping that means anything.
    fn postfix(&mut self) -> Result<Expression, ParseError> {
        let mut target = self.primary()?;
        loop {
            if self.take(&TokenKind::Dot) {
                let span = target.span();
                let name = self.name("a field name after `.`")?;
                target = Expression::Field {
                    target: Box::new(target),
                    name,
                    span: span.to(self.span_before()),
                };
                continue;
            }
            if self.take(&TokenKind::LeftBracket) {
                let span = target.span();
                let index = self.expression()?;
                self.expect(&TokenKind::RightBracket, "`]` to close the index")?;
                target = Expression::Index {
                    target: Box::new(target),
                    index: Box::new(index),
                    span: span.to(self.span_before()),
                };
                continue;
            }
            return Ok(target);
        }
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
            TokenKind::Name(name) if name == "true" || name == "false" => {
                self.advance();
                Ok(Expression::Boolean { value: name == "true", span })
            }
            // `if` used where a value is expected, written on ONE line:
            //
            //     let sign = if n < 0 then -1 else 1
            //
            // One line rather than an indented block, because an
            // expression can appear mid-line — inside a call argument,
            // on the right of a `let` — where opening a block would put
            // the layout rule in conflict with itself. The multi-line
            // shape is the STATEMENT form, which is where a body belongs.
            //
            // `then` separates the condition from the value. Without it,
            // `if a - 1 else` would have to guess where the condition
            // stops.
            //
            // `else` is required: an expression must have a value either
            // way.
            TokenKind::Name(name) if name == "if" => {
                self.advance();
                let condition = self.expression()?;
                if self.peek_name() != Some("then") {
                    return Err(self.error_here(
                        "expected `then` after the condition of an `if` used as a value",
                    ));
                }
                self.advance();
                let then_value = self.expression()?;
                if self.peek_name() != Some("else") {
                    return Err(self.error_here(
                        "an `if` used as a value needs an `else`, since it must have a value either way",
                    ));
                }
                self.advance();
                let else_value = self.expression()?;
                let span = span.to(self.span_before());
                Ok(Expression::If {
                    condition: Box::new(condition),
                    then_branch: vec![Statement::Return {
                        value: Some(then_value),
                        span,
                    }],
                    else_branch: vec![Statement::Return {
                        value: Some(else_value),
                        span,
                    }],
                    span,
                })
            }
            TokenKind::LeftBracket => {
                self.advance();
                let mut elements = Vec::new();
                while !self.check(&TokenKind::RightBracket) {
                    elements.push(self.expression()?);
                    if !self.take(&TokenKind::Comma) {
                        break;
                    }
                }
                self.expect(&TokenKind::RightBracket, "`]` to close the array")?;
                Ok(Expression::Array { elements, span: span.to(self.span_before()) })
            }
            TokenKind::Name(name) => {
                self.advance();
                if self.take(&TokenKind::LeftParen) {
                    // The CASE decides: `Point(…)` builds a shape,
                    // `add(…)` calls a function. Both name what goes in
                    // them, so the two read alike and only the name says
                    // which is which.
                    if Self::starts_uppercase(&name) {
                        let fields = self.named_arguments("field")?;
                        let span = span.to(self.span_before());
                        return Ok(Expression::Construct { shape: name, fields, span });
                    }

                    let arguments = self.named_arguments("parameter")?;
                    let span = span.to(self.span_before());
                    return Ok(Expression::Call { callee: name, arguments, span });
                }
                Ok(Expression::Name { name, span })
            }
            _ => Err(self.error_here("expected a value")),
        }
    }

    fn peek_operator(&self) -> Option<BinaryOperator> {
        // Written as words rather than `&&` and `||`: they read as what
        // they are, and there is no bitwise pair to confuse them with.
        match self.peek_name() {
            Some("and") => return Some(BinaryOperator::And),
            Some("or") => return Some(BinaryOperator::Or),
            _ => {}
        }
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

    /// The token `ahead` positions on, clamped the same way.
    fn peek_at(&self, ahead: usize) -> &Token {
        &self.tokens[(self.at + ahead).min(self.tokens.len() - 1)]
    }

    /// `name: value, name: value)` — the inside of a call or a
    /// construction, which are written the same way.
    ///
    /// Every argument is named. Positional would be shorter, but two
    /// parameters of the same type could then be swapped without anyone
    /// noticing, and the reader would have to go find the signature to
    /// know what the second `10` meant.
    fn named_arguments(&mut self, what: &str) -> Result<Vec<FieldValue>, ParseError> {
        let mut arguments = Vec::new();
        while !self.check(&TokenKind::RightParen) {
            let start = self.span_here();
            let name_span = self.span_here();
            let name = self.name(&format!("a {what} name"))?;
            if arguments.iter().any(|given: &FieldValue| given.name == name) {
                return Err(ParseError {
                    message: format!("`{name}` is given twice"),
                    span: name_span,
                });
            }
            self.expect(&TokenKind::Colon, &format!("`:` after the {what} name"))?;
            let value = self.expression()?;
            arguments.push(FieldValue {
                name,
                value,
                span: start.to(self.span_before()),
            });
            if !self.take(&TokenKind::Comma) {
                break;
            }
        }
        self.expect(&TokenKind::RightParen, "`)` to close them")?;
        Ok(arguments)
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
