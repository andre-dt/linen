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
    /// `if condition <block>` with an optional `else`, as a STATEMENT —
    /// for the early-return shape, where there is no value to produce.
    If {
        condition: Expression,
        then_branch: Vec<Statement>,
        else_branch: Option<Vec<Statement>>,
        span: Span,
    },
    /// `while condition <block>`
    While {
        condition: Expression,
        body: Vec<Statement>,
        span: Span,
    },
    /// `for name in start .. end <block>`
    For {
        name: String,
        start: Expression,
        end: Expression,
        body: Vec<Statement>,
        span: Span,
    },
    /// `throw "message" if condition` / `throw "message" unless condition`
    ///
    /// Always fatal: it ends the test where it stands. There is no catch,
    /// so no function needs a failure path in its type and nothing needs
    /// unwinding — the whole feature costs nothing until it fires.
    ///
    /// A statement rather than a call, because it needs the SOURCE TEXT
    /// of its condition to say which one did not hold, and a normal call
    /// receives a value with the text long gone.
    Throw {
        message: String,
        /// `if` throws when the condition holds; `unless` throws when it
        /// does not. Two words rather than one plus `not`, so a guard and
        /// an assertion are each written the way they read.
        sense: ThrowSense,
        condition: Expression,
        span: Span,
    },
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum ThrowSense {
    /// `throw ... if cond` — the condition is what must NOT happen.
    When,
    /// `throw ... unless cond` — the condition is what must hold.
    Unless,
}

#[derive(Debug, PartialEq)]
pub enum Expression {
    Integer {
        value: i64,
        span: Span,
    },
    Boolean {
        value: bool,
        span: Span,
    },
    /// `if condition <block> else <block>`, as a VALUE.
    ///
    /// The else is not optional here: an `if` used as a value has to have
    /// one, or there would be nothing to evaluate to when the condition
    /// is false. The statement form — where it may be omitted — is
    /// `Statement::If`.
    If {
        condition: Box<Expression>,
        then_branch: Vec<Statement>,
        else_branch: Vec<Statement>,
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
            | Expression::Boolean { span, .. }
            | Expression::If { span, .. }
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
    Not,
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
    And,
    Or,
}

impl BinaryOperator {
    /// Tighter binds first. Comparison sits below arithmetic so
    /// `a + b == c` groups as `(a + b) == c`, which is what everyone
    /// reading it expects.
    pub fn precedence(self) -> u8 {
        match self {
            // Loosest, so `a == b and c == d` groups the way it reads.
            BinaryOperator::Or => 1,
            BinaryOperator::And => 2,
            BinaryOperator::Equal
            | BinaryOperator::NotEqual
            | BinaryOperator::Less
            | BinaryOperator::LessOrEqual
            | BinaryOperator::Greater
            | BinaryOperator::GreaterOrEqual => 3,
            BinaryOperator::Add | BinaryOperator::Subtract => 4,
            BinaryOperator::Multiply | BinaryOperator::Divide | BinaryOperator::Remainder => 5,
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
            BinaryOperator::And => "and",
            BinaryOperator::Or => "or",
        }
    }
}
