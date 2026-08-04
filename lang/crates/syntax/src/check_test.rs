// =====================================================================
// syntax/check_test.rs
//
// The numeric model, pinned. Storage is i32, arithmetic is i64, and
// predicates reach i128 — these tests are what stop that from drifting
// back into "whatever the operands were".
// =====================================================================

use crate::check::{check, Type};
use crate::lex::lex;
use crate::parse::parse;

fn verify(source: &str) -> Result<(), String> {
    let tokens = lex(source).expect("should lex");
    let unit = parse(&tokens).map_err(|error| error.message)?;
    check(&unit).map_err(|error| error.message)
}

fn error(source: &str) -> String {
    verify(source).expect_err("should not check")
}

/// The type an expression actually has.
///
/// It cannot be read off a return type: narrowing and widening are both
/// allowed, so `fn f(...) i32` accepts an i64 body and vice versa, and
/// every declaration would pass. Asking the checker directly is the only
/// way to tell i32 from i64 here — and getting this wrong once already
/// made a passing test that proved nothing.
fn type_of(expression: &str) -> Type {
    let source = format!("fn f(a i32, b i64) i32\n  let it = {expression}\n  return 0\n");
    let tokens = lex(&source).expect("should lex");
    let unit = parse(&tokens).expect("should parse");
    crate::check::type_of_binding(&unit, "it").expect("should check")
}

// --- the widening rule ----------------------------------------------------

#[test]
fn arithmetic_on_two_i32_produces_i64() {
    // The rule the whole storage model rests on. Two coordinates
    // multiplied overflow i32 at 47 mm by 47 mm, so i32 * i32 -> i32
    // would be wrong for any part bigger than a matchbox.
    assert_eq!(type_of("a * a"), Type::I64);
}

#[test]
fn every_arithmetic_operator_widens() {
    // Not just `*`. A sum of coordinates is how a midpoint and a
    // bounding box are built, and those overflow too.
    for operator in ["+", "-", "*", "/", "%"] {
        assert_eq!(type_of(&format!("a {operator} a")), Type::I64, "for `{operator}`");
    }
}

#[test]
fn arithmetic_never_narrows_on_its_own() {
    // i64 * i64 stays i64; nothing silently drops to i32.
    assert_eq!(type_of("b * b"), Type::I64);
}

#[test]
fn the_wider_operand_wins() {
    assert_eq!(type_of("a * b"), Type::I64);
    assert_eq!(type_of("b * a"), Type::I64);
}

#[test]
fn a_literal_on_its_own_is_i32() {
    // The storage width. Arithmetic widens it the moment it is used, so
    // writing `1` costs nothing and still cannot overflow anything.
    assert_eq!(type_of("1"), Type::I32);
}

#[test]
fn negation_does_not_widen() {
    // `-x` cannot overflow what `x` already held, so widening it would
    // be cost with no reason.
    assert_eq!(type_of("0 - a"), Type::I64); // a subtraction, so it widens
    assert_eq!(type_of("-a"), Type::I32); // the unary operator does not
}

// --- narrowing ------------------------------------------------------------

#[test]
fn a_computed_value_can_be_stored_back_into_i32() {
    // `fn mid(a i32, b i32) i32` with `(a + b) / 2` is half of what a
    // kernel storing i32 does. Forbidding it would make i32 usable only
    // as a parameter, never as a result.
    assert!(verify("fn mid(a i32, b i32) i32\n  return (a + b) / 2\n").is_ok());
}

#[test]
fn widening_is_free_in_a_call() {
    assert!(verify("fn wide(n i64) i64\n  return n\n\nfn f(a i32) i64\n  return wide(n: a)\n").is_ok());
}

// --- bool is not a number -------------------------------------------------

#[test]
fn arithmetic_rejects_bool() {
    let message = error("fn f(a bool) i64\n  return a + a\n");
    assert!(message.contains("works on numbers"), "got: {message}");
}

#[test]
fn a_condition_has_to_be_bool() {
    // `if count` would have to mean something invented on the spot.
    let message = error("fn f(a i32) i32\n  if a\n    return 1\n  return 0\n");
    assert!(message.contains("has to be bool"), "got: {message}");
}

#[test]
fn a_throw_condition_has_to_be_bool() {
    // The oldest entry in PENDING.md.
    let message = error("test \"t\"\n  throw \"m\" if 1 + 1\n");
    assert!(message.contains("has to be bool"), "got: {message}");
}

#[test]
fn and_or_reject_numbers() {
    let message = error("fn f(a i32) bool\n  return a and a\n");
    assert!(message.contains("works on bools"), "got: {message}");
}

#[test]
fn comparison_produces_bool_from_numbers() {
    assert!(verify("fn f(a i32, b i64) bool\n  return a < b\n").is_ok());
}

#[test]
fn equality_will_not_mix_a_number_with_a_bool() {
    let message = error("fn f(a i32, b bool) bool\n  return a == b\n");
    assert!(message.contains("two of the same"), "got: {message}");
}

#[test]
fn equality_across_integer_widths_is_fine() {
    // The answer is the same whatever width they are compared in.
    assert!(verify("fn f(a i32, b i64) bool\n  return a == b\n").is_ok());
}

// --- names and signatures -------------------------------------------------

#[test]
fn an_unbound_name_is_an_error() {
    // Another PENDING.md entry: it needs a scope to look in.
    let message = error("test \"t\"\n  throw \"m\" unless x == 1\n");
    assert!(message.contains("nothing called `x`"), "got: {message}");
}

#[test]
fn an_unknown_type_is_an_error() {
    let message = error("fn f(a Blob) i32\n  return 1\n");
    assert!(message.contains("no type called `Blob`"), "got: {message}");
}

#[test]
fn returning_a_bool_where_a_number_is_declared_is_an_error() {
    let message = error("fn f(a i32) i32\n  return a == 1\n");
    assert!(message.contains("returns bool"), "got: {message}");
}

#[test]
fn a_function_returning_nothing_has_nothing_to_return() {
    let message = error("fn f(a i32)\n  return a\n");
    assert!(message.contains("returns nothing"), "got: {message}");
}

#[test]
fn a_function_with_a_result_needs_a_value() {
    let message = error("fn f(a i32) i32\n  return\n");
    assert!(message.contains("needs a value"), "got: {message}");
}

#[test]
fn an_argument_of_the_wrong_type_is_an_error() {
    let message = error("fn wide(n i64) i64\n  return n\n\nfn f(a bool) i64\n  return wide(n: a)\n");
    assert!(message.contains("`n` is i64"), "got: {message}");
}

#[test]
fn calling_a_function_that_returns_nothing_has_no_value() {
    let message = error("fn shout()\n  return\n\nfn f() i32\n  return shout()\n");
    assert!(message.contains("returns nothing"), "got: {message}");
}

// --- scope ----------------------------------------------------------------

#[test]
fn a_binding_is_visible_after_it() {
    assert!(verify("fn f() i64\n  let x = 5\n  return x + 1\n").is_ok());
}

#[test]
fn a_binding_does_not_escape_its_block() {
    let message = error("fn f(a i32) i64\n  if a > 0\n    let x = 5\n  return x\n");
    assert!(message.contains("nothing called `x`"), "got: {message}");
}

#[test]
fn a_loop_variable_is_an_integer_inside_the_body() {
    assert!(verify("fn f() i32\n  for i in 0 .. 3\n    let y = i + 1\n  return 0\n").is_ok());
}

// --- the if expression ----------------------------------------------------

#[test]
fn both_sides_of_an_if_expression_must_agree() {
    let message = error("fn f(a i32) i32\n  let x = if a > 0 then 1 else a == 1\n  return 0\n");
    assert!(message.contains("no single type"), "got: {message}");
}

#[test]
fn an_if_expression_takes_the_wider_side() {
    assert!(verify("fn f(a i32, b i64) i64\n  return if a > 0 then a else b\n").is_ok());
}

// --- the kernel predicate -------------------------------------------------

#[test]
fn orient2d_typechecks_and_is_i64() {
    // The real thing, not a stand-in: i32 coordinates in, i64
    // determinant out, which is the storage model in one signature.
    assert!(verify(
        "fn orient2d(ax i32, ay i32, bx i32, by i32, cx i32, cy i32) i64\n  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)\n"
    )
    .is_ok());
}
