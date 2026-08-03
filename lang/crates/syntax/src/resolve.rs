// =====================================================================
// syntax/resolve.rs — MATCHING ARGUMENTS TO WHAT THEY FILL.
//
// The first pass that needs to see more than one place at once. The
// parser reads `add(a: 1, b: 2)` without knowing what `add` is; only
// here, with the declarations collected, can the arguments be checked
// against them.
//
// Scoped deliberately to argument matching. It is not the typechecker —
// nothing here knows that `1` is an i32 — and pretending otherwise would
// mean a half-written checker nobody trusts. What it does cover, it
// covers completely.
//
// THREE RULES
// -----------
//   named      every argument names what it fills
//   ordered    in the order the declaration lists them
//   complete   everything without a default is given
//
// Order is checked rather than ignored because argument order is the one
// thing a reader uses to match a call against a signature at a glance.
// Allowing `add(b: 2, a: 1)` would mean two ways to write one call, and
// the reader would have to check which they were looking at every time.
//
// It is also what makes omission unambiguous: arguments run in
// declaration order, so a missing one is read off its position rather
// than guessed at.
// =====================================================================

use std::collections::HashMap;

use crate::ast::*;
use crate::token::Span;

#[derive(Debug, PartialEq)]
pub struct ResolveError {
    pub message: String,
    pub span: Span,
}

/// What a call or a construction can be filling: a list of names, each
/// either required or not. Functions and shapes differ in nothing else
/// that matters here, so they share one path rather than two that drift.
struct Signature {
    /// What it is called in a message: "function" or "shape".
    kind: &'static str,
    slots: Vec<Slot>,
}

struct Slot {
    name: String,
    required: bool,
}

pub fn resolve(unit: &Unit) -> Result<(), ResolveError> {
    let mut signatures: HashMap<&str, Signature> = HashMap::new();

    for item in &unit.items {
        match item {
            Item::Function(function) => {
                signatures.insert(
                    &function.name,
                    Signature {
                        kind: "function",
                        slots: function
                            .parameters
                            .iter()
                            .map(|parameter| Slot {
                                name: parameter.name.clone(),
                                required: parameter.default.is_none(),
                            })
                            .collect(),
                    },
                );
            }
            Item::Shape(shape) => {
                signatures.insert(
                    &shape.name,
                    Signature {
                        kind: "shape",
                        slots: shape
                            .fields
                            .iter()
                            .map(|field| Slot {
                                name: field.name.clone(),
                                required: field.default.is_none(),
                            })
                            .collect(),
                    },
                );
            }
            Item::Test(_) => {}
        }
    }

    for item in &unit.items {
        match item {
            Item::Function(function) => check_statements(&function.body, &signatures)?,
            Item::Test(test) => check_statements(&test.body, &signatures)?,
            Item::Shape(_) => {}
        }
    }
    Ok(())
}

fn check_statements(
    statements: &[Statement],
    signatures: &HashMap<&str, Signature>,
) -> Result<(), ResolveError> {
    for statement in statements {
        match statement {
            Statement::Let { value, .. } => check_expression(value, signatures)?,
            Statement::Return { value, .. } => {
                if let Some(value) = value {
                    check_expression(value, signatures)?;
                }
            }
            Statement::If { condition, then_branch, else_branch, .. } => {
                check_expression(condition, signatures)?;
                check_statements(then_branch, signatures)?;
                if let Some(else_branch) = else_branch {
                    check_statements(else_branch, signatures)?;
                }
            }
            Statement::While { condition, body, .. } => {
                check_expression(condition, signatures)?;
                check_statements(body, signatures)?;
            }
            Statement::For { start, end, body, .. } => {
                check_expression(start, signatures)?;
                check_expression(end, signatures)?;
                check_statements(body, signatures)?;
            }
            Statement::Throw { condition, .. } => check_expression(condition, signatures)?,
        }
    }
    Ok(())
}

fn check_expression(
    expression: &Expression,
    signatures: &HashMap<&str, Signature>,
) -> Result<(), ResolveError> {
    match expression {
        Expression::Integer { .. } | Expression::Boolean { .. } | Expression::Name { .. } => {}
        Expression::If { condition, then_branch, else_branch, .. } => {
            check_expression(condition, signatures)?;
            check_statements(then_branch, signatures)?;
            check_statements(else_branch, signatures)?;
        }
        Expression::Unary { operand, .. } => check_expression(operand, signatures)?,
        Expression::Binary { left, right, .. } => {
            check_expression(left, signatures)?;
            check_expression(right, signatures)?;
        }
        Expression::Array { elements, .. } => {
            for element in elements {
                check_expression(element, signatures)?;
            }
        }
        Expression::Field { target, .. } => check_expression(target, signatures)?,
        Expression::Index { target, index, .. } => {
            check_expression(target, signatures)?;
            check_expression(index, signatures)?;
        }
        Expression::Call { callee, arguments, span } => {
            check_arguments(callee, arguments, *span, signatures)?;
        }
        Expression::Construct { shape, fields, span } => {
            check_arguments(shape, fields, *span, signatures)?;
        }
    }
    Ok(())
}

/// The three rules, against one signature.
fn check_arguments(
    name: &str,
    given: &[FieldValue],
    span: Span,
    signatures: &HashMap<&str, Signature>,
) -> Result<(), ResolveError> {
    // Every argument is itself an expression that may contain calls.
    for argument in given {
        check_expression(&argument.value, signatures)?;
    }

    let Some(signature) = signatures.get(name) else {
        return Err(ResolveError {
            message: format!("there is no `{name}` here"),
            span,
        });
    };

    // Walk the declared slots and the given arguments together. Each
    // argument must match the next slot that accepts it; a slot passed
    // over must have had a default.
    let mut slot = 0;
    for argument in given {
        // Where this name sits among the slots still ahead of us.
        let found = signature.slots[slot..]
            .iter()
            .position(|candidate| candidate.name == argument.name);

        let Some(offset) = found else {
            // Either it is not a slot at all, or it is one already
            // behind us — and those are different mistakes.
            let message = if signature.slots.iter().any(|s| s.name == argument.name) {
                format!(
                    "`{}` comes before this in `{name}`; arguments go in the order they are declared",
                    argument.name
                )
            } else {
                format!("`{name}` has no {} called `{}`", part_of(signature), argument.name)
            };
            return Err(ResolveError { message, span: argument.span });
        };

        // Everything skipped over was left out — unless it turns up
        // later in the call, which means it was written out of order
        // rather than omitted. Two different mistakes that look alike at
        // this point, and only the rest of the argument list tells them
        // apart.
        for skipped in &signature.slots[slot..slot + offset] {
            if let Some(late) = given.iter().find(|other| other.name == skipped.name) {
                return Err(ResolveError {
                    message: format!(
                        "`{}` comes before `{}` in `{name}`; arguments go in the order they are declared",
                        skipped.name, argument.name
                    ),
                    span: late.span,
                });
            }
            if skipped.required {
                return Err(ResolveError {
                    message: format!(
                        "`{}` of `{name}` has no default, so it must be given",
                        skipped.name
                    ),
                    span: argument.span,
                });
            }
        }
        slot += offset + 1;
    }

    // And whatever is left after the last argument.
    for missing in &signature.slots[slot..] {
        if missing.required {
            return Err(ResolveError {
                message: format!(
                    "`{}` of `{name}` has no default, so it must be given",
                    missing.name
                ),
                span,
            });
        }
    }
    Ok(())
}

fn part_of(signature: &Signature) -> &'static str {
    match signature.kind {
        "shape" => "field",
        _ => "parameter",
    }
}
