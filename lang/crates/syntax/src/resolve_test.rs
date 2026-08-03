// =====================================================================
// syntax/resolve_test.rs
//
// The three rules — named, ordered, complete — and the messages they
// fail with. A rule whose message does not say which argument is at
// fault is a rule the user has to go hunting for.
// =====================================================================

use crate::lex::lex;
use crate::parse::parse;
use crate::resolve::resolve;

fn check(source: &str) -> Result<(), String> {
    let tokens = lex(source).expect("should lex");
    let unit = parse(&tokens).map_err(|error| error.message)?;
    resolve(&unit).map_err(|error| error.message)
}

fn error(source: &str) -> String {
    check(source).expect_err("should not resolve")
}

/// `add` with two required parameters, plus a test that uses it.
fn with_add(call: &str) -> String {
    format!("fn add(a i32, b i32) i32\n  return a + b\n\ntest \"t\"\n  throw \"m\" unless {call} == 3\n")
}

// --- complete -------------------------------------------------------------

#[test]
fn every_required_argument_must_be_given() {
    let message = error(&with_add("add(a: 1)"));
    assert!(message.contains("`b`"), "got: {message}");
    assert!(message.contains("must be given"), "got: {message}");
}

#[test]
fn an_optional_argument_may_be_left_out() {
    // The whole point of a default: the call site says less.
    assert!(check("fn add(a i32, b i32 = 2) i32\n  return a + b\n\ntest \"t\"\n  throw \"m\" unless add(a: 1) == 3\n").is_ok());
}

#[test]
fn an_optional_argument_may_also_be_given() {
    assert!(check("fn add(a i32, b i32 = 2) i32\n  return a + b\n\ntest \"t\"\n  throw \"m\" unless add(a: 1, b: 9) == 10\n").is_ok());
}

#[test]
fn a_skipped_optional_does_not_hide_a_required_one() {
    // `c` is required and sits after an optional, which the parser
    // rejects at the declaration — so this checks the declaration rule
    // fires before a call can even be written against it.
    let message = error("fn f(a i32, b i32 = 2, c i32) i32\n  return a\n");
    assert!(message.contains("`c`"), "got: {message}");
    assert!(message.contains("must come before"), "got: {message}");
}

// --- ordered --------------------------------------------------------------

#[test]
fn arguments_come_in_the_order_they_are_declared() {
    // Out of order would be a second way to write the same call, and the
    // reader would have to check which one they were looking at.
    let message = error(&with_add("add(b: 2, a: 1)"));
    assert!(message.contains("comes before"), "got: {message}");
}

#[test]
fn skipping_an_optional_keeps_the_rest_in_order() {
    assert!(check("fn f(a i32, b i32 = 2, c i32 = 3) i32\n  return a\n\ntest \"t\"\n  throw \"m\" unless f(a: 1, c: 9) == 1\n").is_ok());
}

// --- named ----------------------------------------------------------------

#[test]
fn an_argument_must_name_something_that_exists() {
    let message = error(&with_add("add(a: 1, z: 2)"));
    assert!(message.contains("no parameter called `z`"), "got: {message}");
}

#[test]
fn a_shape_says_field_not_parameter() {
    let message = error("shape Point\n  x i32\n\ntest \"t\"\n  throw \"m\" unless Point(x: 1, z: 2).x == 1\n");
    assert!(message.contains("no field called `z`"), "got: {message}");
}

#[test]
fn an_argument_is_not_given_twice() {
    let message = error(&with_add("add(a: 1, a: 2)"));
    assert!(message.contains("given twice"), "got: {message}");
}

#[test]
fn calling_something_that_does_not_exist_is_an_error() {
    // One of the oldest entries in PENDING.md — resolution is what
    // finally makes it catchable.
    let message = error("test \"t\"\n  throw \"m\" unless nope(a: 1) == 1\n");
    assert!(message.contains("no `nope`"), "got: {message}");
}

// --- shapes take defaults too ---------------------------------------------

#[test]
fn a_shape_field_may_have_a_default() {
    assert!(check("shape Point\n  x i32\n  y i32 = 0\n\ntest \"t\"\n  throw \"m\" unless Point(x: 1).y == 0\n").is_ok());
}

#[test]
fn a_shape_field_without_a_default_must_be_given() {
    let message = error("shape Point\n  x i32\n  y i32\n\ntest \"t\"\n  throw \"m\" unless Point(x: 1).y == 0\n");
    assert!(message.contains("`y`"), "got: {message}");
    assert!(message.contains("must be given"), "got: {message}");
}

#[test]
fn a_shape_puts_its_required_fields_first() {
    let message = error("shape Point\n  x i32 = 0\n  y i32\n");
    assert!(message.contains("must come before"), "got: {message}");
}

// --- arguments nest -------------------------------------------------------

#[test]
fn the_rules_apply_inside_an_argument() {
    // `add(a: add(a: 1))` — the inner call is checked too, or a whole
    // class of mistakes would hide one level down.
    let message = error("fn add(a i32, b i32) i32\n  return a + b\n\ntest \"t\"\n  throw \"m\" unless add(a: add(a: 1), b: 2) == 3\n");
    assert!(message.contains("`b`"), "got: {message}");
}
