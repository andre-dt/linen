// =====================================================================
// syntax/check.rs — TYPES.
//
// Where `i32` stops being a name and becomes a thing with a width. Until
// here the parser carried type names around without knowing what any of
// them meant.
//
// THE NUMERIC MODEL
// -----------------
// There is no floating point. Geometry is integer arithmetic, in
// microns, for the reason a financial system counts cents: rounding
// error is not small, it is cumulative, and in a BREP kernel it does not
// yield a slightly wrong number — it yields an inconsistent solid.
//
//   i32    what a coordinate is STORED as     12 bytes per 3D point
//   i64    what every calculation runs in     10^12 headroom
//   i128   what predicates need               orient3d is a triple product
//
// So arithmetic WIDENS: i32 + i32 is i64, not i32. That is the whole
// point of storing in 32 and computing in 64 — a `pattern` repeating a
// part at 10 m from the origin overflows i32 and does not come close to
// overflowing i64.
//
// Narrowing back to i32 is never implicit. A value that does not fit is
// an error, never a number that quietly wrapped.
// =====================================================================

use std::cell::RefCell;
use std::rc::Rc;
use std::collections::HashMap;

use crate::ast::*;
use crate::token::Span;

#[derive(Debug, PartialEq)]
pub struct CheckError {
    pub message: String,
    pub span: Span,
}

/// A type, resolved. Small and Copy on purpose — it is passed by value
/// through every expression in the program.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Type {
    I32,
    I64,
    I128,
    Bool,
    /// A shape, by its position in the unit's list of shapes.
    ///
    /// An index rather than the name, so Type stays Copy — it is passed
    /// by value through every expression, and making it own a String
    /// would put a clone on that path for no gain. The name is recovered
    /// from the program when a message needs it.
    Shape(usize),
    /// `[i32; 3]` — an element type and a count, both in the TYPE.
    ///
    /// Interned by position in the program's array table, for the same
    /// reason a shape is: a nested `Type` would have to own its element,
    /// and Type is passed by value everywhere.
    ///
    /// The size being part of the type is what lets the value live
    /// without an allocation — the space is known at compile time.
    Array(usize),
    /// The element type of an empty `list()`, before a push decides it.
    ///
    /// A placeholder, not a type anything can hold: it exists so that
    /// "has not been decided" is distinguishable from "is i32", which it
    /// was not when the default was i32 — and then a list of numbers
    /// accepted a bool.
    Unknown,
    /// `List<i32>` — a sequence whose length is not in its type.
    ///
    /// Interned like an array, but carrying only an element type: a
    /// List that knew its length would be an array, and the whole point
    /// is the shapes whose size is not known until they are built. A
    /// face has however many loops it has.
    ///
    /// Where an array lives in the value, a List lives in the ARENA —
    /// which is what makes it the thing that can grow, and what makes it
    /// die with the call that built it.
    List(usize),
}

impl Type {
    /// What to call this type in a message.
    ///
    /// A shape cannot name itself from a Type alone — it only carries an
    /// index — so this is the fallback. Anything holding a Program
    /// should use `Program::name_of`, which says `Point`.
    pub fn name(self) -> &'static str {
        match self {
            Type::I32 => "i32",
            Type::I64 => "i64",
            Type::I128 => "i128",
            Type::Bool => "bool",
            Type::Shape(_) => "a shape",
            Type::Array(_) => "an array",
            Type::List(_) => "a list",
            Type::Unknown => "not yet decided",
        }
    }

    /// The primitive types only. A shape is named by the unit it is
    /// declared in, so it cannot be resolved from a name alone.
    pub fn from_name(name: &str) -> Option<Type> {
        Some(match name {
            "i32" => Type::I32,
            "i64" => Type::I64,
            "i128" => Type::I128,
            "bool" => Type::Bool,
            _ => return None,
        })
    }

    pub fn is_integer(self) -> bool {
        matches!(self, Type::I32 | Type::I64 | Type::I128)
    }

    /// How many bits, for deciding which of two integer types is wider.
    ///
    /// A shape has no width in this sense — it is never an operand of
    /// arithmetic, and `is_integer` is false for it, so nothing that
    /// compares widths ever reaches one.
    pub fn width(self) -> u8 {
        match self {
            Type::I32 => 32,
            Type::I64 => 64,
            Type::I128 => 128,
            Type::Bool => 1,
            Type::Shape(_) | Type::Array(_) | Type::List(_) | Type::Unknown => 0,
        }
    }
}

/// The type a written number gets: the narrowest one that holds it.
///
/// The lexer parses into i64, so anything wider than i32 lands here as
/// i64. There is no i128 literal yet, and there is no way to write one
/// that would need it.
pub fn literal_type(value: i64) -> Type {
    if value >= i32::MIN as i64 && value <= i32::MAX as i64 {
        Type::I32
    } else {
        Type::I64
    }
}

/// What arithmetic over two integers produces.
///
/// At least i64, always. Two i32 coordinates multiplied is 10^14, which
/// leaves i32 far behind — and silently wrapping there is exactly the
/// class of bug the integer model exists to remove. Storage is 32;
/// arithmetic is not.
fn arithmetic_result(left: Type, right: Type) -> Type {
    let widest = if left.width() >= right.width() { left } else { right };
    match widest {
        Type::I32 => Type::I64,
        other => other,
    }
}

/// Whether a value of `from` may be used where `to` is wanted.
///
/// Integers convert either way, and the asymmetry is in what it costs
/// rather than in what is allowed. Widening is free and always correct.
/// Narrowing is checked AT RUNTIME: the value either fits the smaller
/// type or the operation fails — it never wraps.
///
/// Narrowing has to be allowed, or the arithmetic model would eat
/// itself. Multiplying two coordinates has to produce i64, since i32
/// overflows at 47 mm by 47 mm; but a kernel that stores i32 has to be
/// able to put a computed value back, and `fn mid(a i32, b i32) i32`
/// with `(a + b) / 2` is the shape half of it takes. Forbidding the
/// write-back would make i32 unusable as anything but a parameter.
///
/// A wrap would be silent and wrong. A failure is loud and right, and
/// costs one compare on a path that is already touching memory.
fn assignable(from: Type, to: Type) -> bool {
    if from == to || (from.is_integer() && to.is_integer()) {
        return true;
    }
    // An undecided type fits anywhere: `fn f() List<i32>` returning
    // `list()` is a list that has not been pushed into, and the
    // declaration is what decides what it holds.
    from == Type::Unknown || to == Type::Unknown
}

/// Whether an undecided list can flow where `to` is wanted.
///
/// `List<Unknown>` is what `list()` produces, and it belongs anywhere a
/// list belongs. Compared structurally rather than by index, because the
/// two are different entries in the table and equality on the index
/// would say no.
fn lists_agree(from: Type, to: Type, program: &Program) -> bool {
    let (Type::List(a), Type::List(b)) = (from, to) else {
        return false;
    };
    let (Some(a), Some(b)) = (program.arrays.get(a), program.arrays.get(b)) else {
        return false;
    };
    a.element == Type::Unknown || b.element == Type::Unknown || assignable(a.element, b.element)
}

/// A written number that cannot fit where it is going.
///
/// Checked here, at compile time, because both halves are known: the
/// value is written in the source and the type is declared. Everything
/// else that narrows is a runtime concern — a computed i64 might or
/// might not fit an i32 — but a literal is decidable now, and letting it
/// through would wrap 10^12 to -727379968.
///
/// That number looks plausible, which is what makes it the worst kind of
/// wrong. It is also exactly the failure the integer model exists to
/// prevent, so catching it is not an extra: it is the model holding.
fn literal_fits(expression: &Expression, wanted: Type) -> Result<(), CheckError> {
    let Expression::Integer { value, span } = expression else {
        return Ok(());
    };
    let fits = match wanted {
        Type::I32 => *value >= i32::MIN as i64 && *value <= i32::MAX as i64,
        // The lexer parses into i64, so anything that got here already
        // fits i64 and i128.
        Type::I64 | Type::I128 => true,
        Type::Bool | Type::Shape(_) | Type::Array(_) | Type::List(_) | Type::Unknown => true,
    };
    if fits {
        return Ok(());
    }
    Err(CheckError {
        message: format!("{value} does not fit in {}", wanted.name()),
        span: *span,
    })
}

// =====================================================================
// what is in scope
// =====================================================================

struct Signature {
    parameters: Vec<(String, Type)>,
    result: Option<Type>,
}

struct ShapeInfo {
    fields: Vec<(String, Type)>,
}

/// `[element; size]`, as resolved.
#[derive(Clone, Copy, PartialEq)]
pub struct ArrayInfo {
    pub element: Type,
    pub size: i64,
}

/// The array types a unit mentions, interned.
///
/// Rebuilt the same way by the checker and the backend: both walk the
/// unit in the same order, so `Type::Array(i)` means the same thing in
/// both. Interning rather than nesting keeps `Type` Copy.
/// Behind a RefCell because an array type can be discovered while an
/// expression is being CHECKED — `[1, 2, 3]` names a type no signature
/// mentions — and checking otherwise takes `&Program`.
/// Shared, not copied. `clone` hands out another handle to the SAME
/// table — an array literal typed through one handle has to be visible
/// through every other, or the backend would number types differently
/// from the checker and read the wrong element type.
#[derive(Default, Clone)]
pub struct Arrays {
    entries: Rc<RefCell<Vec<ArrayInfo>>>,
}

impl Arrays {
    /// `List<element>`, interned by element type.
    ///
    /// Kept in the same table as arrays, distinguished by size: a list
    /// has none. One table rather than two, because both answer the same
    /// question — what is in it — and two would be two places to look.
    fn intern_list(&self, element: Type) -> Type {
        let mut entries = self.entries.borrow_mut();
        if let Some(index) = entries
            .iter()
            .position(|entry| entry.element == element && entry.size < 0)
        {
            return Type::List(index);
        }
        entries.push(ArrayInfo { element, size: -1 });
        Type::List(entries.len() - 1)
    }

    fn intern(&self, info: ArrayInfo) -> Type {
        let mut entries = self.entries.borrow_mut();
        if let Some(index) = entries.iter().position(|entry| *entry == info) {
            return Type::Array(index);
        }
        entries.push(info);
        Type::Array(entries.len() - 1)
    }

    pub fn get(&self, index: usize) -> Option<ArrayInfo> {
        self.entries.borrow().get(index).copied()
    }
}

impl Program {
    /// A written type, resolved against this program.
    ///
    /// Every array it could name was already interned by `program_of` —
    /// signatures and fields are the only places a type is written — so
    /// this never adds an entry and the indices stay stable.
    fn type_of_written(&self, type_name: &TypeName) -> Result<Type, CheckError> {
        resolve_type(type_name, &self.names, &self.arrays)
    }

    fn type_of_parameter(&self, parameter: &Parameter) -> Result<Type, CheckError> {
        self.type_of_written(&parameter.type_name)
    }

    /// The type of an array of `element` with `size` elements.
    ///
    /// A literal can name a type no signature mentions, so this may
    /// intern a new entry — which is why the table lives behind a cell
    /// rather than being frozen after `program_of`.
    fn array_of(&self, element: Type, size: i64) -> Type {
        self.arrays.intern(ArrayInfo { element, size })
    }

    /// What to call a type in a message, with a shape named properly.
    fn name_of(&self, of: Type) -> String {
        match of {
            Type::Shape(index) => self.names[index].clone(),
            other => other.name().to_string(),
        }
    }
}

struct Program {
    functions: HashMap<String, Signature>,
    shapes: HashMap<String, ShapeInfo>,
    /// The shape names in source order. `Type::Shape(i)` indexes this,
    /// which is how a shape type gets named in a message.
    names: Vec<String>,
    arrays: Arrays,
}

pub fn check(unit: &Unit) -> Result<(), CheckError> {
    let program = program_of(unit)?;
    check_names(unit)?;
    check_against(unit, &program)
}

/// One name, one declaration.
///
/// Two functions sharing a name compiles today and one of them wins,
/// which makes the other dead code that reads as live — and a reader has
/// no way to tell which one a call reaches.
fn check_names(unit: &Unit) -> Result<(), CheckError> {
    let mut seen: Vec<(&str, &'static str)> = Vec::new();
    for item in &unit.items {
        let (name, what, span) = match item {
            Item::Function(function) => (function.name.as_str(), "function", function.span),
            Item::Shape(shape) => (shape.name.as_str(), "shape", shape.span),
            // A test's name is prose, not an identifier: two tests may
            // reasonably describe themselves the same way, and nothing
            // refers to a test by name.
            Item::Test(_) => continue,
        };
        if let Some((_, first)) = seen.iter().find(|(other, _)| *other == name) {
            return Err(CheckError {
                message: format!("`{name}` is declared twice; the first was a {first}"),
                span,
            });
        }
        seen.push((name, what));
    }
    Ok(())
}

/// Whether a body always reaches a `return`.
///
/// The compiler fills in a zero for a body that runs off the end, which
/// turns a forgotten branch into a plausible number rather than a
/// failure. In a kernel that zero is a coordinate — a point at the
/// origin, which reads as geometry rather than as a bug.
///
/// Conservative on loops: a `while` may run zero times, so a `return`
/// inside one does not count. That rejects some correct programs, and
/// the alternative is accepting incorrect ones.
fn always_returns(body: &[Statement]) -> bool {
    body.iter().any(|statement| match statement {
        Statement::Return { .. } => true,
        // Both branches, or neither: an `if` without an `else` falls
        // through when the condition does not hold.
        Statement::If { then_branch, else_branch, .. } => match else_branch {
            Some(else_branch) => {
                always_returns(then_branch) && always_returns(else_branch)
            }
            None => false,
        },
        // A throw ends the test where it stands, so anything after it is
        // unreachable — but a throw is conditional, so it is not a
        // return.
        _ => false,
    })
}

/// Checks a unit against a program already built from it.
///
/// Separate from `check` so a caller that needs the array table gets the
/// one checking populated — a literal like `[1, 2, 3]` interns an entry
/// that no signature mentions, and rebuilding the program afterwards
/// would lose it.
fn check_against(unit: &Unit, program: &Program) -> Result<(), CheckError> {
    // The bodies, now that every signature is known.
    for item in &unit.items {
        match item {
            Item::Function(function) => {
                let mut scope: Vec<(String, Type)> = Vec::new();
                for parameter in &function.parameters {
                    scope.push((
                        parameter.name.clone(),
                        program.type_of_parameter(parameter)?,
                    ));
                }
                let expected = match &function.result {
                    Some(type_name) => Some(program.type_of_written(type_name)?),
                    None => None,
                };
                check_body(&function.body, &mut scope, expected, program)?;

                if expected.is_some() && !always_returns(&function.body) {
                    return Err(CheckError {
                        message: format!(
                            "`{}` can end without returning, but it declares a result",
                            function.name
                        ),
                        span: function.span,
                    });
                }
            }
            Item::Test(test) => {
                let mut scope = Vec::new();
                check_body(&test.body, &mut scope, None, program)?;
            }
            Item::Shape(_) => {}
        }
    }
    Ok(())
}

/// A written type, resolved against a unit and a shared array table.
///
/// The backend calls this rather than reimplementing it: a second copy
/// of the rule is a second place for it to go wrong, and it already did
/// — the backend's copy forgot arrays entirely and sent `[i32; 3]` down
/// the shape path.
pub fn resolve_written(
    unit: &Unit,
    type_name: &TypeName,
    arrays: &Arrays,
) -> Result<Type, CheckError> {
    resolve_type(type_name, &shape_names(unit), arrays)
}

/// The array table a unit produces, for the backend.
///
/// Handed over rather than rebuilt: `Type::Array(i)` indexes it, and two
/// tables built separately could disagree about which `i` is which.
pub fn arrays_of(unit: &Unit) -> Result<Arrays, CheckError> {
    let program = program_of(unit)?;
    // Checking is what interns the entries only literals mention, so it
    // has to run against THIS program, not a fresh one.
    check_against(unit, &program)?;
    Ok(program.arrays)
}

/// The names the List builtins take.
const LIST: &str = "list";
const PUSH: &str = "push";
const LENGTH: &str = "length";
const AT: &str = "at";

fn is_list_builtin(name: &str) -> bool {
    matches!(name, LIST | PUSH | LENGTH | AT)
}

/// Types the four List builtins.
fn check_list_builtin(
    callee: &str,
    arguments: &[FieldValue],
    span: Span,
    scope: &Scope,
    program: &Program,
) -> Result<Type, CheckError> {
    /// The argument with this name, or an error naming what is missing.
    fn argument<'a>(
        arguments: &'a [FieldValue],
        wanted: &str,
        callee: &str,
        span: Span,
    ) -> Result<&'a FieldValue, CheckError> {
        arguments
            .iter()
            .find(|given| given.name == wanted)
            .ok_or_else(|| CheckError {
                message: format!("`{callee}` needs `{wanted}`"),
                span,
            })
    }

    match callee {
        // `list()` — an empty list, of nothing in particular yet.
        //
        // Its element is `Unknown`: a real type variable would need the
        // inference that arrives with generics, and typing it `i32` by
        // default was worse than a placeholder — a list genuinely
        // holding i32 was then indistinguishable from one that had not
        // decided, so pushing a bool onto `[1]` was accepted.
        LIST => {
            if !arguments.is_empty() {
                return Err(CheckError {
                    message: "`list` takes nothing; it makes an empty list".to_string(),
                    span,
                });
            }
            Ok(program.arrays.intern_list(Type::Unknown))
        }

        // `push(list: xs, value: v)` — a NEW list, one longer.
        PUSH => {
            let given = argument(arguments, "list", callee, span)?;
            let value = argument(arguments, "value", callee, span)?;
            let of = check_expression(&given.value, scope, program)?;
            let Type::List(entry) = of else {
                return Err(CheckError {
                    message: format!(
                        "`list` of `push` is a list, but this is {}",
                        program.name_of(of)
                    ),
                    span: given.value.span(),
                });
            };
            let element = program
                .arrays
                .get(entry)
                .expect("interned when the type was resolved")
                .element;
            let pushed = check_expression(&value.value, scope, program)?;

            // The first push into an empty list is what decides its
            // element type. After that the type is fixed.
            //
            // Except when the value is a WIDENED integer. Arithmetic
            // widens — `n * 4` is i64 even where every operand is i32 —
            // so inferring from it silently makes a `List<i64>` out of
            // what the author meant as a list of coordinates. Stored
            // eight bytes wide and later read four bytes wide through a
            // declared `List<i32>`, every element after the first comes
            // out of the wrong place, and the first one is right — which
            // is what makes a small test miss it.
            //
            // The type has to be written down, and saying so is cheap.
            if element == Type::Unknown {
                if pushed == Type::I64 || pushed == Type::I128 {
                    return Err(CheckError {
                        message: format!(
                            "this list has no element type yet, and {} is what arithmetic \
                             produces rather than what was meant; say what the list holds",
                            program.name_of(pushed)
                        ),
                        span: value.value.span(),
                    });
                }
                return Ok(program.arrays.intern_list(pushed));
            }
            if !assignable(pushed, element) {
                return Err(CheckError {
                    message: format!(
                        "this list holds {}, but this value is {}",
                        program.name_of(element),
                        program.name_of(pushed)
                    ),
                    span: value.value.span(),
                });
            }
            Ok(of)
        }

        // `length(list: xs)` — how many.
        LENGTH => {
            let given = argument(arguments, "list", callee, span)?;
            let of = check_expression(&given.value, scope, program)?;
            if !matches!(of, Type::List(_)) {
                return Err(CheckError {
                    message: format!(
                        "`length` takes a list, but this is {}",
                        program.name_of(of)
                    ),
                    span: given.value.span(),
                });
            }
            Ok(Type::I32)
        }

        // `at(list: xs, index: i)` — the element there.
        AT => {
            let given = argument(arguments, "list", callee, span)?;
            let index = argument(arguments, "index", callee, span)?;
            let of = check_expression(&given.value, scope, program)?;
            let Type::List(entry) = of else {
                return Err(CheckError {
                    message: format!("`at` takes a list, but this is {}", program.name_of(of)),
                    span: given.value.span(),
                });
            };
            let position = check_expression(&index.value, scope, program)?;
            if !position.is_integer() {
                return Err(CheckError {
                    message: format!(
                        "an index is a number, but this is {}",
                        program.name_of(position)
                    ),
                    span: index.value.span(),
                });
            }
            Ok(program
                .arrays
                .get(entry)
                .expect("interned when the type was resolved")
                .element)
        }

        _ => unreachable!("checked by is_list_builtin"),
    }
}

/// The builtin a drawing test calls to hand over its mesh.
pub const SOLID: &str = "solid";

/// `solid(points: …, triangles: …)` — numbers, as an array or a list.
///
/// Both, because both are how a mesh legitimately arrives. A test that
/// writes its corners out literally knows how many there are, and a
/// fixed array costs no allocation. A tessellated body does not: a face
/// has however many triangles its loop yields, and that is only known
/// once it is clipped.
fn check_solid(
    arguments: &[FieldValue],
    span: Span,
    scope: &Scope,
    program: &Program,
) -> Result<Type, CheckError> {
    let mut seen = Vec::new();
    for argument in arguments {
        let of = check_expression(&argument.value, scope, program)?;
        let element = match of {
            Type::Array(entry) => program
                .arrays
                .get(entry)
                .expect("interned when the type was resolved")
                .element,
            Type::List(entry) => program
                .arrays
                .get(entry)
                .expect("interned when the type was resolved")
                .element,
            _ => {
                return Err(CheckError {
                    message: format!(
                        "`{}` of `solid` is numbers, as an array or a list, but this is {}",
                        argument.name,
                        program.name_of(of)
                    ),
                    span: argument.value.span(),
                });
            }
        };
        if !element.is_integer() {
            return Err(CheckError {
                message: format!(
                    "`{}` of `solid` holds numbers, but this array holds {}",
                    argument.name,
                    program.name_of(element)
                ),
                span: argument.value.span(),
            });
        }
        seen.push(argument.name.as_str());
    }

    for wanted in ["points", "triangles"] {
        if !seen.contains(&wanted) {
            return Err(CheckError {
                message: format!("`solid` needs `{wanted}`"),
                span,
            });
        }
    }
    // Produces nothing: it is an instruction to the runner, not a value.
    Ok(Type::Bool)
}

/// The type of an expression, given what is in scope around it.
///
/// The backend asks rather than re-deriving, so codegen and the checker
/// cannot disagree about where a value widened — and a disagreement
/// there would be a wrong number, not a compile error.
pub fn type_of(
    unit: &Unit,
    expression: &Expression,
    bindings: &[(String, Type)],
    arrays: &Arrays,
) -> Result<Type, CheckError> {
    // The caller's table, not a fresh one: an array literal interns an
    // entry as it is typed, and `Type::Array(i)` has to mean the same
    // thing to the caller as it does here. A fresh table would number
    // the same types differently — and that is a wrong value, not a
    // compile error.
    let mut program = program_of(unit)?;
    program.arrays = arrays.clone();
    let scope: Scope = bindings.to_vec();
    check_expression(expression, &scope, &program)
}

/// The signatures of a unit, collected once.
fn program_of(unit: &Unit) -> Result<Program, CheckError> {
    let names = shape_names(unit);
    let arrays = Arrays::default();
    let mut program = Program {
        functions: HashMap::new(),
        shapes: HashMap::new(),
        names: names.clone(),
        arrays: Arrays::default(),
    };
    for item in &unit.items {
        match item {
            Item::Shape(shape) => {
                let mut fields = Vec::new();
                for field in &shape.fields {
                    fields.push((field.name.clone(), resolve_type(&field.type_name, &names, &arrays)?));
                }
                program.shapes.insert(shape.name.clone(), ShapeInfo { fields });
            }
            Item::Function(function) => {
                let mut parameters = Vec::new();
                for parameter in &function.parameters {
                    parameters
                        .push((parameter.name.clone(), resolve_type(&parameter.type_name, &names, &arrays)?));
                }
                let result = match &function.result {
                    Some(type_name) => Some(resolve_type(type_name, &names, &arrays)?),
                    None => None,
                };
                program
                    .functions
                    .insert(function.name.clone(), Signature { parameters, result });
            }
            Item::Test(_) => {}
        }
    }
    program.arrays = arrays;
    Ok(program)
}

/// The type given to a named binding, once the unit checks.
///
/// Exposed because the type of an expression is not observable from the
/// outside otherwise: narrowing and widening are both allowed, so every
/// declared return type accepts every integer body, and a test that
/// tried to read a type off a signature would pass no matter what the
/// rule was.
pub fn type_of_binding(unit: &Unit, wanted: &str) -> Result<Type, CheckError> {
    check(unit)?;
    let mut found = None;
    for item in &unit.items {
        let (body, parameters) = match item {
            Item::Function(function) => (&function.body, Some(&function.parameters)),
            Item::Test(test) => (&test.body, None),
            Item::Shape(_) => continue,
        };
        let program = program_of(unit)?;
        let mut scope: Scope = Vec::new();
        if let Some(parameters) = parameters {
            for parameter in parameters {
                scope.push((
                    parameter.name.clone(),
                    program.type_of_parameter(parameter)?,
                ));
            }
        }
        for statement in body {
            if let Statement::Let { name, value, .. } = statement {
                let bound = check_expression(value, &scope, &program)?;
                if name == wanted {
                    found = Some(bound);
                }
                scope.push((name.clone(), bound));
            }
        }
    }
    found.ok_or_else(|| CheckError {
        message: format!("there is no binding called `{wanted}`"),
        span: Span::new(0, 0),
    })
}

/// A written type name, resolved to a type.
///
/// Shapes, arrays and List are not here yet: they need a Type that can
/// nest, and the first thing the kernel needs is arithmetic. Naming one
/// says so rather than pretending it worked.
fn resolve_type(
    type_name: &TypeName,
    shapes: &[String],
    arrays: &Arrays,
) -> Result<Type, CheckError> {
    // `[element; size]` — the size is part of the type, which is what
    // lets the value live without an allocation.
    if let Some(size) = type_name.array_size {
        if size < 0 {
            return Err(CheckError {
                message: format!("an array cannot have {size} elements"),
                span: type_name.span,
            });
        }
        let written = type_name.arguments.first().ok_or_else(|| CheckError {
            message: "an array type needs an element type".to_string(),
            span: type_name.span,
        })?;
        let element = resolve_type(written, shapes, arrays)?;
        return Ok(arrays.intern(ArrayInfo { element, size }));
    }
    // `List<T>` — the one written type with an argument.
    if type_name.name == "List" {
        let written = type_name.arguments.first().ok_or_else(|| CheckError {
            message: "`List` needs an element type, as in `List<i32>`".to_string(),
            span: type_name.span,
        })?;
        let element = resolve_type(written, shapes, arrays)?;
        return Ok(arrays.intern_list(element));
    }

    if let Some(primitive) = Type::from_name(&type_name.name) {
        return Ok(primitive);
    }
    // A shape, by where it was declared. The names are collected before
    // any type is resolved, so a shape may name one declared below it —
    // the language has no ordering rule and should not grow one.
    if let Some(index) = shapes.iter().position(|name| *name == type_name.name) {
        return Ok(Type::Shape(index));
    }
    Err(CheckError {
        message: format!("there is no type called `{}`", type_name.name),
        span: type_name.span,
    })
}

/// The shapes a unit declares, in source order. The index into this is
/// what `Type::Shape` carries.
fn shape_names(unit: &Unit) -> Vec<String> {
    unit.items
        .iter()
        .filter_map(|item| match item {
            Item::Shape(shape) => Some(shape.name.clone()),
            _ => None,
        })
        .collect()
}

// =====================================================================
// statements
// =====================================================================

/// The scope is a stack of (name, type) searched from the back, so a
/// later binding shadows an earlier one without anything being removed.
type Scope = Vec<(String, Type)>;

fn check_body(
    statements: &[Statement],
    scope: &mut Scope,
    result: Option<Type>,
    program: &Program,
) -> Result<(), CheckError> {
    let depth = scope.len();
    for statement in statements {
        check_statement(statement, scope, result, program)?;
    }
    // Everything bound inside the block leaves with it.
    scope.truncate(depth);
    Ok(())
}

fn check_statement(
    statement: &Statement,
    scope: &mut Scope,
    result: Option<Type>,
    program: &Program,
) -> Result<(), CheckError> {
    match statement {
        Statement::Let { name, value, .. } => {
            let bound = check_expression(value, scope, program)?;
            scope.push((name.clone(), bound));
        }

        Statement::Return { value, span } => match (value, result) {
            (Some(value), Some(expected)) => {
                let found = check_expression(value, scope, program)?;
                if !assignable(found, expected) && !lists_agree(found, expected, program) {
                    return Err(CheckError {
                        message: format!(
                            "this returns {}, but the function is declared to return {}",
                            found.name(),
                            expected.name()
                        ),
                        span: value.span(),
                    });
                }
                literal_fits(value, expected)?;
            }
            (Some(value), None) => {
                return Err(CheckError {
                    message: "this function returns nothing, so it has nothing to return"
                        .to_string(),
                    span: value.span(),
                })
            }
            (None, Some(expected)) => {
                return Err(CheckError {
                    message: format!(
                        "this function returns {}, so `return` needs a value",
                        expected.name()
                    ),
                    span: *span,
                })
            }
            (None, None) => {}
        },

        Statement::If { condition, then_branch, else_branch, .. } => {
            expect_bool(condition, scope, program, "a condition")?;
            check_body(then_branch, scope, result, program)?;
            if let Some(else_branch) = else_branch {
                check_body(else_branch, scope, result, program)?;
            }
        }

        Statement::While { condition, body, .. } => {
            expect_bool(condition, scope, program, "a condition")?;
            check_body(body, scope, result, program)?;
        }

        Statement::For { name, start, end, body, .. } => {
            let from = check_expression(start, scope, program)?;
            let to = check_expression(end, scope, program)?;
            for (bound, expression) in [(from, start), (to, end)] {
                if !bound.is_integer() {
                    return Err(CheckError {
                        message: format!(
                            "a range runs over integers, but this is {}",
                            bound.name()
                        ),
                        span: expression.span(),
                    });
                }
            }
            let depth = scope.len();
            scope.push((name.clone(), arithmetic_result(from, to)));
            check_body(body, scope, result, program)?;
            scope.truncate(depth);
        }

        Statement::Solid { arguments, span } => {
            check_solid(arguments, *span, scope, program)?;
        }

        // The condition decides whether the test dies, so it has to be a
        // question with a yes-or-no answer. `throw "m" if count` would
        // otherwise mean something invented on the spot.
        Statement::Throw { condition, .. } => {
            expect_bool(condition, scope, program, "the condition of a `throw`")?;
        }
    }
    Ok(())
}

fn expect_bool(
    expression: &Expression,
    scope: &Scope,
    program: &Program,
    what: &str,
) -> Result<(), CheckError> {
    let found = check_expression(expression, scope, program)?;
    if found != Type::Bool {
        return Err(CheckError {
            message: format!("{what} has to be bool, but this is {}", found.name()),
            span: expression.span(),
        });
    }
    Ok(())
}

// =====================================================================
// expressions
// =====================================================================

fn check_expression(
    expression: &Expression,
    scope: &Scope,
    program: &Program,
) -> Result<Type, CheckError> {
    match expression {
        // A literal is the narrowest type that HOLDS it: i32 for one that
        // fits, i64 otherwise. Typing every literal i32 would truncate
        // the ones that do not fit — and a determinant written out in a
        // test, like 100000000000000, is exactly such a literal.
        //
        // Narrowest rather than always-i64 so that `1` stays i32 and
        // arithmetic on coordinates widens from the storage width, which
        // is what the model says it does.
        Expression::Integer { value, .. } => Ok(literal_type(*value)),
        Expression::Boolean { .. } => Ok(Type::Bool),

        Expression::Name { name, span } => scope
            .iter()
            .rev()
            .find(|(bound, _)| bound == name)
            .map(|(_, bound)| *bound)
            .ok_or_else(|| CheckError {
                message: format!("there is nothing called `{name}` here"),
                span: *span,
            }),

        Expression::Unary { operator, operand, span } => {
            let found = check_expression(operand, scope, program)?;
            match operator {
                UnaryOperator::Not if found == Type::Bool => Ok(Type::Bool),
                UnaryOperator::Not => Err(CheckError {
                    message: format!("`not` needs a bool, but this is {}", found.name()),
                    span: *span,
                }),
                // Negation does not widen: `-x` cannot overflow what `x`
                // already held.
                UnaryOperator::Negate if found.is_integer() => Ok(found),
                UnaryOperator::Negate => Err(CheckError {
                    message: format!("`-` needs a number, but this is {}", found.name()),
                    span: *span,
                }),
            }
        }

        Expression::Binary { operator, left, right, span } => {
            let a = check_expression(left, scope, program)?;
            let b = check_expression(right, scope, program)?;
            check_binary(*operator, a, b, *span)
        }

        Expression::If { condition, then_branch, else_branch, span } => {
            expect_bool(condition, scope, program, "a condition")?;
            // Both arms are `return <expression>` as the parser builds
            // them, so the type of the whole is the type of either.
            let then_type = branch_type(then_branch, scope, program)?;
            let else_type = branch_type(else_branch, scope, program)?;
            if assignable(then_type, else_type) {
                return Ok(else_type);
            }
            if assignable(else_type, then_type) {
                return Ok(then_type);
            }
            Err(CheckError {
                message: format!(
                    "the two sides of this `if` are {} and {}, so it has no single type",
                    then_type.name(),
                    else_type.name()
                ),
                span: *span,
            })
        }

        // The List builtins.
        //
        // Builtins rather than declarations in a prelude, because their
        // types cannot be written in this language yet: `push` is
        // generic over the element AND returns a List of it, which needs
        // the monomorphisation that has not landed. Writing them here
        // keeps the language honest — nothing pretends to be ordinary
        // user code that is not.
        Expression::Call { callee, arguments, span } if is_list_builtin(callee) => {
            check_list_builtin(callee, arguments, *span, scope, program)
        }

        Expression::Call { callee, arguments, span } => {
            // resolve.rs already matched names, order and completeness,
            // so this only has to agree on types.
            let signature = program.functions.get(callee).ok_or_else(|| CheckError {
                message: format!("there is no `{callee}` here"),
                span: *span,
            })?;
            for argument in arguments {
                let found = check_expression(&argument.value, scope, program)?;
                let expected = signature
                    .parameters
                    .iter()
                    .find(|(name, _)| *name == argument.name)
                    .map(|(_, type_of)| *type_of)
                    .ok_or_else(|| CheckError {
                        message: format!("`{callee}` has no parameter called `{}`", argument.name),
                        span: argument.span,
                    })?;
                if !assignable(found, expected) && !lists_agree(found, expected, program) {
                    return Err(CheckError {
                        message: format!(
                            "`{}` is {}, but this is {}",
                            argument.name,
                            program.name_of(expected),
                            program.name_of(found)
                        ),
                        span: argument.value.span(),
                    });
                }
                literal_fits(&argument.value, expected)?;
            }
            signature.result.ok_or_else(|| CheckError {
                message: format!("`{callee}` returns nothing, so it has no value here"),
                span: *span,
            })
        }

        Expression::Construct { shape, fields, span } => {
            let info = program.shapes.get(shape).ok_or_else(|| CheckError {
                message: format!("there is no shape called `{shape}`"),
                span: *span,
            })?;
            for given in fields {
                let found = check_expression(&given.value, scope, program)?;
                let expected = info
                    .fields
                    .iter()
                    .find(|(name, _)| *name == given.name)
                    .map(|(_, type_of)| *type_of)
                    .ok_or_else(|| CheckError {
                        message: format!("`{shape}` has no field called `{}`", given.name),
                        span: given.span,
                    })?;
                if !assignable(found, expected) && !lists_agree(found, expected, program) {
                    return Err(CheckError {
                        message: format!(
                            "`{}` is {}, but this is {}",
                            given.name,
                            program.name_of(expected),
                            program.name_of(found)
                        ),
                        span: given.value.span(),
                    });
                }
                literal_fits(&given.value, expected)?;
            }
            // Building one produces one.
            Ok(Type::Shape(
                program
                    .names
                    .iter()
                    .position(|name| name == shape)
                    .expect("the shape was found above"),
            ))
        }

        // `p.x` — reading a field. The target has to BE a shape, which
        // is the whole reason a shape needed to become a Type.
        Expression::Field { target, name, span } => {
            let of = check_expression(target, scope, program)?;
            let Type::Shape(index) = of else {
                return Err(CheckError {
                    message: format!(
                        "only a shape has fields, and this is {}",
                        program.name_of(of)
                    ),
                    span: *span,
                });
            };
            let shape = &program.names[index];
            let info = &program.shapes[shape];
            info.fields
                .iter()
                .find(|(field, _)| field == name)
                .map(|(_, of)| *of)
                .ok_or_else(|| CheckError {
                    message: format!("`{shape}` has no field called `{name}`"),
                    span: *span,
                })
        }
        // `[1, 2, 3]` — the size comes from how many were written, and
        // every element has to be the same type, because that type is
        // part of the array's own.
        Expression::Array { elements, span } => {
            let Some(first) = elements.first() else {
                return Err(CheckError {
                    message: "an empty array has no element type to infer".to_string(),
                    span: *span,
                });
            };
            let element = check_expression(first, scope, program)?;
            for other in &elements[1..] {
                let found = check_expression(other, scope, program)?;
                if !assignable(found, element) {
                    return Err(CheckError {
                        message: format!(
                            "this array holds {}, but this element is {}",
                            program.name_of(element),
                            program.name_of(found)
                        ),
                        span: other.span(),
                    });
                }
            }
            Ok(program.array_of(element, elements.len() as i64))
        }

        // `xs[i]` — reading an element.
        Expression::Index { target, index, span } => {
            let of = check_expression(target, scope, program)?;
            let Type::Array(entry) = of else {
                return Err(CheckError {
                    message: format!(
                        "only an array can be indexed, and this is {}",
                        program.name_of(of)
                    ),
                    span: *span,
                });
            };
            let position = check_expression(index, scope, program)?;
            if !position.is_integer() {
                return Err(CheckError {
                    message: format!(
                        "an index is a number, but this is {}",
                        program.name_of(position)
                    ),
                    span: index.span(),
                });
            }
            Ok(program
                .arrays
                .get(entry)
                .expect("interned when the type was resolved")
                .element)
        }
    }
}

/// The type a one-line `if` arm produces. The parser builds each arm as a
/// single `return`, so there is exactly one place to look.
fn branch_type(
    branch: &[Statement],
    scope: &Scope,
    program: &Program,
) -> Result<Type, CheckError> {
    match branch.first() {
        Some(Statement::Return { value: Some(value), .. }) => {
            check_expression(value, scope, program)
        }
        _ => unreachable!("the parser builds if-expression arms as a single return"),
    }
}

fn check_binary(
    operator: BinaryOperator,
    left: Type,
    right: Type,
    span: Span,
) -> Result<Type, CheckError> {
    use BinaryOperator::*;
    match operator {
        Add | Subtract | Multiply | Divide | Remainder => {
            if !left.is_integer() || !right.is_integer() {
                return Err(CheckError {
                    message: format!(
                        "`{}` works on numbers, but these are {} and {}",
                        operator.symbol(),
                        left.name(),
                        right.name()
                    ),
                    span,
                });
            }
            Ok(arithmetic_result(left, right))
        }

        Less | LessOrEqual | Greater | GreaterOrEqual => {
            if !left.is_integer() || !right.is_integer() {
                return Err(CheckError {
                    message: format!(
                        "`{}` compares numbers, but these are {} and {}",
                        operator.symbol(),
                        left.name(),
                        right.name()
                    ),
                    span,
                });
            }
            Ok(Type::Bool)
        }

        // Equality is the one place two integer widths meet without
        // widening: the answer is the same whatever they are compared
        // in. Mixing an integer with a bool is still a mistake.
        Equal | NotEqual => {
            if left == right || (left.is_integer() && right.is_integer()) {
                return Ok(Type::Bool);
            }
            Err(CheckError {
                message: format!(
                    "`{}` compares two of the same, but these are {} and {}",
                    operator.symbol(),
                    left.name(),
                    right.name()
                ),
                span,
            })
        }

        And | Or => {
            if left == Type::Bool && right == Type::Bool {
                return Ok(Type::Bool);
            }
            Err(CheckError {
                message: format!(
                    "`{}` works on bools, but these are {} and {}",
                    operator.symbol(),
                    left.name(),
                    right.name()
                ),
                span,
            })
        }
    }
}
