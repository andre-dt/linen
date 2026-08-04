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
    Shape(Shape),
    Test(Test),
}

/// `shape Name` with its fields indented under it.
///
/// Called a shape rather than a struct because that is what it is: the
/// shape of a value, with no methods, no inheritance and no behaviour
/// attached.
#[derive(Debug, PartialEq)]
pub struct Shape {
    pub name: String,
    /// Type parameters, empty for the ordinary case. `shape Pair<T>`.
    pub generics: Vec<GenericParameter>,
    pub fields: Vec<Field>,
    pub span: Span,
}

#[derive(Debug, PartialEq)]
pub struct Field {
    pub name: String,
    pub type_name: TypeName,
    /// `y i32 = 0` — what the field is when a construction leaves it out.
    /// `None` means it must be given. Same rule as a parameter, so the
    /// two do not drift apart.
    pub default: Option<Expression>,
    pub span: Span,
}

/// A type variable as declared: the `T` in `shape Pair<T>`.
#[derive(Debug, PartialEq, Clone)]
pub struct GenericParameter {
    pub name: String,
    pub span: Span,
}

#[derive(Debug, PartialEq)]
pub struct Function {
    pub name: String,
    /// `export fn` — part of the boundary this unit presents to whoever
    /// links it.
    ///
    /// Marked rather than inferred, and off by default: what a caller
    /// outside the language can reach is a decision, and everything not
    /// exported stays free to be renamed or removed. An exported name is
    /// also a symbol in the object file, so the two are the same choice.
    pub exported: bool,
    /// Type parameters, empty for the ordinary case. `fn first<T>(…)`.
    pub generics: Vec<GenericParameter>,
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
    /// `count i32 = 1` — what the parameter is when the caller leaves it
    /// out. `None` means it is required.
    ///
    /// A default is what makes a parameter optional; there is no separate
    /// way to mark one. And because every parameter either is given or
    /// has a default, no value is ever absent — which is why the language
    /// has no null.
    pub default: Option<Expression>,
    pub span: Span,
}

/// A type as WRITTEN. Not yet resolved to anything — `i32` and a
/// misspelling are both just names here, and telling them apart is the
/// checker's job, where there is a scope to look them up in.
#[derive(Debug, PartialEq, Clone)]
pub struct TypeName {
    pub name: String,
    /// `List<i32>` — the arguments applied to the name. Empty for a
    /// plain type.
    pub arguments: Vec<TypeName>,
    /// `[i32; 3]` — a fixed-size array. The size is part of the TYPE, so
    /// it is known at compile time and the value needs no allocation.
    /// `None` for anything that is not an array.
    pub array_size: Option<i64>,
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
    /// `add(a: 1, b: 2)`
    ///
    /// Arguments are named, the same way a construction names its
    /// fields — so a call and a construction read alike, and only the
    /// case of the name says which one it is.
    Call {
        callee: String,
        arguments: Vec<FieldValue>,
        span: Span,
    },
    /// `[1, 2, 3]` — an array literal. Its size comes from how many
    /// elements were written.
    Array {
        elements: Vec<Expression>,
        span: Span,
    },
    /// `Point(x: 1, y: 2)` — building a shape, naming each field.
    ///
    /// Named rather than positional: a shape with two fields of the same
    /// type would otherwise let them be swapped silently, and adding a
    /// field would break every construction quietly rather than loudly.
    Construct {
        shape: String,
        fields: Vec<FieldValue>,
        span: Span,
    },
    /// `p.x` — reading a field.
    Field {
        target: Box<Expression>,
        name: String,
        span: Span,
    },
    /// `xs[0]` — reading an element.
    Index {
        target: Box<Expression>,
        index: Box<Expression>,
        span: Span,
    },
}

#[derive(Debug, PartialEq)]
pub struct FieldValue {
    pub name: String,
    pub value: Expression,
    pub span: Span,
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
            | Expression::Call { span, .. }
            | Expression::Array { span, .. }
            | Expression::Construct { span, .. }
            | Expression::Field { span, .. }
            | Expression::Index { span, .. } => *span,
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
