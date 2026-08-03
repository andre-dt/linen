// =====================================================================
// syntax/ast.rs — THE TREE.
//
// What the parser produces and everything downstream consumes. Shaped as
// Rust enums on purpose: adding a node makes every `match` that forgot
// it a compile error, which is the property that keeps a compiler honest
// as its language grows.
//
// Every node carries a Span. A tree without spans parses fine and then
// cannot tell the user WHERE anything went wrong, and retrofitting them
// later means touching every node — so they go in from the start.
// =====================================================================

use crate::token::Span;

/// A whole source file.
#[derive(Debug, PartialEq)]
pub struct Unit {
    pub items: Vec<Item>,
}

/// Anything that can appear at the top level.
#[derive(Debug, PartialEq)]
pub enum Item {
    Function(Function),
    Test(Test),
}

#[derive(Debug, PartialEq)]
pub struct Function {
    pub name: String,
    pub parameters: Vec<Parameter>,
    /// The declared return type. `None` means the function returns
    /// nothing — written by leaving the type off, not by naming a unit
    /// type, so there is one way to say it.
    pub result: Option<TypeName>,
    pub body: Vec<Statement>,
    pub span: Span,
}

#[derive(Debug, PartialEq)]
pub struct Parameter {
    pub name: String,
    pub type_name: TypeName,
    pub span: Span,
}

/// A type as WRITTEN. Not yet resolved to anything — `i32` and a
/// misspelling are both just names here, and telling them apart is the
/// checker's job, where there is a scope to look them up in.
#[derive(Debug, PartialEq, Clone)]
pub struct TypeName {
    pub name: String,
    pub span: Span,
}

#[derive(Debug, PartialEq)]
pub struct Test {
    pub name: String,
    pub body: Vec<Statement>,
    pub span: Span,
}

#[derive(Debug, PartialEq)]
pub enum Statement {
    /// `let name = value`
    Let {
        name: String,
        value: Expression,
        span: Span,
    },
    /// `return value`
    Return {
        value: Option<Expression>,
        span: Span,
    },
    /// `assert(condition)`
    ///
    /// A statement rather than a call to an ordinary function: it needs
    /// the SOURCE TEXT of its condition to report a useful failure
    /// ("assert(2 + 2 == 5) failed"), and a normal call receives a value
    /// with the text long gone.
    Assert {
        condition: Expression,
        span: Span,
    },
}

#[derive(Debug, PartialEq)]
pub enum Expression {
    Integer {
        value: i64,
        span: Span,
    },
    /// A name being read. Whether it is a local, a parameter or a
    /// function is not decided here.
    Name {
        name: String,
        span: Span,
    },
    Unary {
        operator: UnaryOperator,
        operand: Box<Expression>,
        span: Span,
    },
    Binary {
        operator: BinaryOperator,
        left: Box<Expression>,
        right: Box<Expression>,
        span: Span,
    },
    Call {
        callee: String,
        arguments: Vec<Expression>,
        span: Span,
    },
}

impl Expression {
    pub fn span(&self) -> Span {
        match self {
            Expression::Integer { span, .. }
            | Expression::Name { span, .. }
            | Expression::Unary { span, .. }
            | Expression::Binary { span, .. }
            | Expression::Call { span, .. } => *span,
        }
    }
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum UnaryOperator {
    Negate,
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum BinaryOperator {
    Add,
    Subtract,
    Multiply,
    Divide,
    Remainder,
    Equal,
    NotEqual,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
}

impl BinaryOperator {
    /// Tighter binds first. Comparison sits below arithmetic so
    /// `a + b == c` groups as `(a + b) == c`, which is what everyone
    /// reading it expects.
    pub fn precedence(self) -> u8 {
        match self {
            BinaryOperator::Equal
            | BinaryOperator::NotEqual
            | BinaryOperator::Less
            | BinaryOperator::LessOrEqual
            | BinaryOperator::Greater
            | BinaryOperator::GreaterOrEqual => 1,
            BinaryOperator::Add | BinaryOperator::Subtract => 2,
            BinaryOperator::Multiply | BinaryOperator::Divide | BinaryOperator::Remainder => 3,
        }
    }

    pub fn symbol(self) -> &'static str {
        match self {
            BinaryOperator::Add => "+",
            BinaryOperator::Subtract => "-",
            BinaryOperator::Multiply => "*",
            BinaryOperator::Divide => "/",
            BinaryOperator::Remainder => "%",
            BinaryOperator::Equal => "==",
            BinaryOperator::NotEqual => "!=",
            BinaryOperator::Less => "<",
            BinaryOperator::LessOrEqual => "<=",
            BinaryOperator::Greater => ">",
            BinaryOperator::GreaterOrEqual => ">=",
        }
    }
}
