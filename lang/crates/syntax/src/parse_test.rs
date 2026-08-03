// =====================================================================
// syntax/parse_test.rs
//
// Shape and precedence, plus the errors. A parser that produces the
// right tree for good input and a useless message for bad input is half
// finished — the message is what the user actually meets.
// =====================================================================

use crate::ast::*;
use crate::lex::lex;
use crate::parse::parse;

fn tree(source: &str) -> Unit {
    let tokens = lex(source).expect("should lex");
    parse(&tokens).expect("should parse")
}

fn error(source: &str) -> String {
    let tokens = lex(source).expect("should lex");
    parse(&tokens).expect_err("should not parse").message
}

/// The single test in a unit, for the many cases that parse one.
fn only_test(source: &str) -> Test {
    let mut unit = tree(source);
    match unit.items.remove(0) {
        Item::Test(test) => test,
        other => panic!("expected a test, got {other:?}"),
    }
}

fn only_function(source: &str) -> Function {
    let mut unit = tree(source);
    match unit.items.remove(0) {
        Item::Function(function) => function,
        other => panic!("expected a function, got {other:?}"),
    }
}

/// An expression rendered as a fully parenthesised string, which makes a
/// precedence assertion readable instead of a nest of Box matches.
fn shape(expression: &Expression) -> String {
    match expression {
        Expression::Integer { value, .. } => value.to_string(),
        Expression::Name { name, .. } => name.clone(),
        Expression::Unary { operand, .. } => format!("(-{})", shape(operand)),
        Expression::Binary { operator, left, right, .. } => {
            format!("({} {} {})", shape(left), operator.symbol(), shape(right))
        }
        Expression::Call { callee, arguments, .. } => {
            let args: Vec<_> = arguments.iter().map(shape).collect();
            format!("{callee}({})", args.join(", "))
        }
    }
}

/// The condition of the first assert in a test, as a shape string.
fn asserted(source: &str) -> String {
    let test = only_test(source);
    match &test.body[0] {
        Statement::Assert { condition, .. } => shape(condition),
        other => panic!("expected an assert, got {other:?}"),
    }
}

// --- shape ----------------------------------------------------------------

#[test]
fn parses_a_test_with_an_assert() {
    let test = only_test("test \"arithmetic\"\n  assert(2 + 2 == 4)\n");
    assert_eq!(test.name, "arithmetic");
    assert_eq!(test.body.len(), 1);
}

#[test]
fn parses_a_function_with_parameters_and_a_result() {
    let function = only_function("fn double(n i32) i32\n  return n * 2\n");
    assert_eq!(function.name, "double");
    assert_eq!(function.parameters.len(), 1);
    assert_eq!(function.parameters[0].name, "n");
    assert_eq!(function.parameters[0].type_name.name, "i32");
    assert_eq!(function.result.map(|t| t.name), Some("i32".to_string()));
}

#[test]
fn a_function_without_a_result_type_returns_nothing() {
    // Written by leaving the type off, so there is one way to say it
    // rather than a unit type to also remember.
    let function = only_function("fn shout()\n  return\n");
    assert_eq!(function.result, None);
}

#[test]
fn parses_several_parameters() {
    let function = only_function("fn add(a i32, b i32) i32\n  return a + b\n");
    assert_eq!(function.parameters.len(), 2);
}

#[test]
fn parses_a_let_binding() {
    let test = only_test("test \"binding\"\n  let x = 5\n  assert(x == 5)\n");
    match &test.body[0] {
        Statement::Let { name, .. } => assert_eq!(name, "x"),
        other => panic!("expected a let, got {other:?}"),
    }
}

#[test]
fn parses_a_call_with_arguments() {
    assert_eq!(asserted("test \"t\"\n  assert(add(1, 2) == 3)\n"), "(add(1, 2) == 3)");
}

#[test]
fn parses_a_call_with_no_arguments() {
    assert_eq!(asserted("test \"t\"\n  assert(now() == 0)\n"), "(now() == 0)");
}

#[test]
fn parses_several_items_in_one_file() {
    let unit = tree("fn double(n i32) i32\n  return n * 2\n\ntest \"t\"\n  assert(double(2) == 4)\n");
    assert_eq!(unit.items.len(), 2);
}

// --- precedence -----------------------------------------------------------

#[test]
fn multiplication_binds_tighter_than_addition() {
    assert_eq!(asserted("test \"t\"\n  assert(2 + 3 * 4 == 14)\n"), "((2 + (3 * 4)) == 14)");
}

#[test]
fn comparison_binds_loosest() {
    // `a + b == c` has to group as `(a + b) == c` — the other reading
    // would compare `b` to `c` and add the result, which is nobody's
    // expectation.
    assert_eq!(asserted("test \"t\"\n  assert(1 + 1 == 2)\n"), "((1 + 1) == 2)");
}

#[test]
fn arithmetic_is_left_associative() {
    // `10 - 3 - 2` is 5, not 9. Right-associating subtraction is the
    // classic precedence-climbing slip.
    assert_eq!(asserted("test \"t\"\n  assert(10 - 3 - 2 == 5)\n"), "(((10 - 3) - 2) == 5)");
}

#[test]
fn parentheses_override_precedence() {
    assert_eq!(asserted("test \"t\"\n  assert((2 + 3) * 4 == 20)\n"), "(((2 + 3) * 4) == 20)");
}

#[test]
fn negation_binds_tighter_than_arithmetic() {
    // `-5 + 1` is `(-5) + 1`, not `-(5 + 1)`.
    assert_eq!(asserted("test \"t\"\n  assert(-5 + 1 == -4)\n"), "(((-5) + 1) == (-4))");
}

// --- errors ---------------------------------------------------------------

#[test]
fn names_what_was_found_not_only_what_was_wanted() {
    // "expected `)`" alone leaves the user hunting; saying what is there
    // instead points at the mistake.
    let message = error("test \"t\"\n  assert(1 + 1\n");
    assert!(message.contains("expected"), "got: {message}");
    assert!(message.contains("found"), "got: {message}");
}

#[test]
fn rejects_a_test_named_without_quotes() {
    let message = error("test arithmetic\n  assert(1 == 1)\n");
    assert!(message.contains("quoted text"), "got: {message}");
}

#[test]
fn rejects_a_body_that_is_not_indented() {
    let message = error("test \"t\"\nassert(1 == 1)\n");
    assert!(message.contains("indented"), "got: {message}");
}

#[test]
fn rejects_an_unknown_statement() {
    let message = error("test \"t\"\n  x = 5\n");
    assert!(message.contains("`let`"), "got: {message}");
}

#[test]
fn rejects_a_stray_top_level_statement() {
    let message = error("let x = 5\n");
    assert!(message.contains("`fn` or `test`"), "got: {message}");
}
