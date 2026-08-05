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
    let (tokens, comments) = crate::lex::lex_with_comments(source).expect("should lex");
    crate::parse::parse_with_comments(&tokens, &comments).expect("should parse")
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
        Expression::Boolean { value, .. } => value.to_string(),
        Expression::If { condition, .. } => format!("if({})", shape(condition)),
        Expression::Name { name, .. } => name.clone(),
        Expression::Unary { operator, operand, .. } => match operator {
            UnaryOperator::Negate => format!("(-{})", shape(operand)),
            UnaryOperator::Not => format!("(not {})", shape(operand)),
        },
        Expression::Binary { operator, left, right, .. } => {
            format!("({} {} {})", shape(left), operator.symbol(), shape(right))
        }
        Expression::Call { callee, arguments, .. } => {
            let args: Vec<_> = arguments
                .iter()
                .map(|argument| format!("{}: {}", argument.name, shape(&argument.value)))
                .collect();
            format!("{callee}({})", args.join(", "))
        }
        Expression::Array { elements, .. } => {
            let items: Vec<_> = elements.iter().map(shape).collect();
            format!("[{}]", items.join(", "))
        }
        Expression::Construct { shape: name, fields, .. } => {
            let written: Vec<_> = fields
                .iter()
                .map(|field| format!("{}: {}", field.name, shape(&field.value)))
                .collect();
            format!("{name}({})", written.join(", "))
        }
        Expression::Field { target, name, .. } => format!("{}.{name}", shape(target)),
        Expression::Index { target, index, .. } => {
            format!("{}[{}]", shape(target), shape(index))
        }
    }
}

/// The condition of the first `throw` in a test, as a shape string.
fn thrown(source: &str) -> String {
    let test = only_test(source);
    match &test.body[0] {
        Statement::Throw { condition, .. } => shape(condition),
        other => panic!("expected a throw, got {other:?}"),
    }
}

// --- shape ----------------------------------------------------------------

#[test]
fn parses_a_test_with_an_assert() {
    let test = only_test("test \"arithmetic\"\n  throw \"m\" unless 2 + 2 == 4\n");
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
    let test = only_test("test \"binding\"\n  let x = 5\n  throw \"m\" unless x == 5\n");
    match &test.body[0] {
        Statement::Let { name, .. } => assert_eq!(name, "x"),
        other => panic!("expected a let, got {other:?}"),
    }
}

#[test]
fn parses_a_call_with_arguments() {
    assert_eq!(thrown("test \"t\"\n  throw \"m\" unless add(a: 1, b: 2) == 3\n"), "(add(a: 1, b: 2) == 3)");
}

#[test]
fn parses_a_call_with_no_arguments() {
    assert_eq!(thrown("test \"t\"\n  throw \"m\" unless now() == 0\n"), "(now() == 0)");
}

#[test]
fn parses_several_items_in_one_file() {
    let unit = tree("fn double(n i32) i32\n  return n * 2\n\ntest \"t\"\n  throw \"m\" unless double(n: 2) == 4\n");
    assert_eq!(unit.items.len(), 2);
}

// --- precedence -----------------------------------------------------------

#[test]
fn multiplication_binds_tighter_than_addition() {
    assert_eq!(thrown("test \"t\"\n  throw \"m\" unless 2 + 3 * 4 == 14\n"), "((2 + (3 * 4)) == 14)");
}

#[test]
fn comparison_binds_loosest() {
    // `a + b == c` has to group as `(a + b) == c` — the other reading
    // would compare `b` to `c` and add the result, which is nobody's
    // expectation.
    assert_eq!(thrown("test \"t\"\n  throw \"m\" unless 1 + 1 == 2\n"), "((1 + 1) == 2)");
}

#[test]
fn arithmetic_is_left_associative() {
    // `10 - 3 - 2` is 5, not 9. Right-associating subtraction is the
    // classic precedence-climbing slip.
    assert_eq!(thrown("test \"t\"\n  throw \"m\" unless 10 - 3 - 2 == 5\n"), "(((10 - 3) - 2) == 5)");
}

#[test]
fn parentheses_override_precedence() {
    assert_eq!(thrown("test \"t\"\n  throw \"m\" unless (2 + 3) * 4 == 20\n"), "(((2 + 3) * 4) == 20)");
}

#[test]
fn negation_binds_tighter_than_arithmetic() {
    // `-5 + 1` is `(-5) + 1`, not `-(5 + 1)`.
    assert_eq!(thrown("test \"t\"\n  throw \"m\" unless -5 + 1 == -4\n"), "(((-5) + 1) == (-4))");
}

// --- errors ---------------------------------------------------------------

#[test]
fn names_what_was_found_not_only_what_was_wanted() {
    // "expected `)`" alone leaves the user hunting; saying what is there
    // instead points at the mistake.
    let message = error("test \"t\"\n  throw \"m\" unless 1 +\n");
    assert!(message.contains("expected"), "got: {message}");
    assert!(message.contains("found"), "got: {message}");
}

#[test]
fn rejects_a_test_named_without_quotes() {
    let message = error("test arithmetic\n  throw \"m\" unless 1 == 1\n");
    assert!(message.contains("quoted text"), "got: {message}");
}

#[test]
fn rejects_a_body_that_is_not_indented() {
    let message = error("test \"t\"\nthrow \"m\" unless 1 == 1\n");
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
    assert!(message.contains("at the top level"), "got: {message}");
}

// --- naming ---------------------------------------------------------------

#[test]
fn a_function_name_must_start_lowercase() {
    // The case is grammar, not convention: it is what tells `Point(x: 1)`
    // from `add(a: 1)` at the first token.
    let message = error("fn Double(n i32) i32\n  return n\n");
    assert!(message.contains("names a shape"), "got: {message}");
}

#[test]
fn a_shape_name_must_start_uppercase() {
    let message = error("shape point\n  x i32\n");
    assert!(message.contains("names a function"), "got: {message}");
}

#[test]
fn a_call_names_every_argument() {
    // Positional would let two parameters of the same type be swapped
    // without anyone noticing.
    let message = error("fn add(a i32, b i32) i32\n  return a\ntest \"t\"\n  throw \"m\" unless add(1, 2) == 3\n");
    assert!(message.contains("parameter name"), "got: {message}");
}

#[test]
fn a_construction_and_a_call_read_alike() {
    // Both name what goes in them; only the case says which is which.
    assert_eq!(
        thrown("test \"t\"\n  throw \"m\" unless add(a: 1, b: 2) == 3\n"),
        "(add(a: 1, b: 2) == 3)"
    );
    assert_eq!(
        thrown("test \"t\"\n  throw \"m\" unless Point(x: 1, y: 2).x == 1\n"),
        "(Point(x: 1, y: 2).x == 1)"
    );
}

// =====================================================================
// A COMMENT BELONGS TO WHAT IT EXPLAINS.
//
// The block of `#` lines above a function or a test is part of that
// declaration, not something floating beside it. Kept on the AST node,
// so anything that reorders or reformats a file carries the
// explanation with the thing explained — rather than each such tool
// guessing at the attachment, and guessing differently.
// =====================================================================

#[test]
fn a_function_keeps_the_comment_above_it() {
    let unit = tree("# What it does.\n# And why.\nfn f() i32\n  return 1\n");
    let Item::Function(function) = &unit.items[0] else {
        panic!("expected a function");
    };
    assert_eq!(
        function.comment.as_deref(),
        Some("What it does.\nAnd why."),
        "the block above a function is its own"
    );
}

#[test]
fn a_test_keeps_the_comment_above_it() {
    let unit = tree("# Why this matters.\ntest \"t\"\n  throw \"x\" unless 1 == 1\n");
    let Item::Test(test) = &unit.items[0] else {
        panic!("expected a test");
    };
    assert_eq!(test.comment.as_deref(), Some("Why this matters."));
}

#[test]
fn a_blank_line_separates_a_comment_from_what_follows() {
    // A comment with a blank line under it is not attached: it is
    // about the file, or about the section, and moving it with the
    // next declaration would put it somewhere it does not belong.
    let unit = tree("# About the file.\n\nfn f() i32\n  return 1\n");
    let Item::Function(function) = &unit.items[0] else {
        panic!("expected a function");
    };
    assert_eq!(
        function.comment, None,
        "a blank line means the comment was not about this function"
    );
}

#[test]
fn a_declaration_without_a_comment_has_none() {
    let unit = tree("fn f() i32\n  return 1\n");
    let Item::Function(function) = &unit.items[0] else {
        panic!("expected a function");
    };
    assert_eq!(function.comment, None);
}

#[test]
fn a_shape_keeps_its_comment() {
    let unit = tree("# A point in the plane.\nshape Point\n  x i32\n  y i32\n");
    let Item::Shape(shape) = &unit.items[0] else {
        panic!("expected a shape");
    };
    assert_eq!(shape.comment.as_deref(), Some("A point in the plane."));
}
