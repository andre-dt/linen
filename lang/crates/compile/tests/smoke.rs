use syntax::{lex::lex, parse::parse};
use compile::run::run_tests;

fn run(source: &str) -> Vec<(String, Option<String>)> {
    let tokens = lex(source).expect("lex");
    let unit = parse(&tokens).expect("parse");
    run_tests(&unit, "smoke")
        .expect("emit")
        .into_iter()
        .map(|r| (r.name, r.failed))
        .collect()
}

#[test]
fn a_test_that_holds_returns_nothing() {
    let out = run("test \"t\"\n  throw \"two and two\" unless 2 + 2 == 4\n");
    assert_eq!(out, vec![("t".to_string(), None)]);
}

#[test]
fn a_test_that_fails_names_its_message() {
    let out = run("test \"t\"\n  throw \"two and two is not five\" unless 2 + 2 == 5\n");
    assert_eq!(out[0].1.as_deref(), Some("two and two is not five"));
}

#[test]
fn orient2d_actually_computes() {
    let out = run(
        "fn orient2d(ax i32, ay i32, bx i32, by i32, cx i32, cy i32) i64\n  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)\n\ntest \"big\"\n  throw \"should be 1e14\" unless orient2d(ax: 0, ay: 0, bx: 10000000, by: 0, cx: 0, cy: 10000000) == 100000000000000\n"
    );
    assert_eq!(out[0].1, None, "the i64 determinant should be exact");
}

// =====================================================================
// Reading past the end of a list.
//
// Asserted here rather than in a `.lang` file because a `.lang` test
// that reads out of range fails by design, and the suite is only worth
// having while green means sound.
//
// It used to be a SEGFAULT: `at` returned null for an out-of-range
// index and the generated code dereferenced it, so a bug two layers up
// arrived as a dead process with no test name attached. The point of
// these is that the defect now names itself.
// =====================================================================

#[test]
fn reading_past_the_end_of_a_list_is_reported() {
    let out = run(
        "test \"t\"\n  let xs = push(list: push(list: list(), value: 1), value: 2)\n  throw \"unreachable\" unless at(list: xs, index: 5) == 0\n",
    );
    let failed = out[0].1.as_deref().expect("an out-of-range read should fail the test");
    assert!(
        failed.contains("element 5") && failed.contains("holding 2"),
        "the message should say which index and how long the list was, got: {failed}"
    );
}

#[test]
fn reading_a_negative_index_is_reported() {
    let out = run(
        "test \"t\"\n  let xs = push(list: list(), value: 1)\n  throw \"unreachable\" unless at(list: xs, index: 0 - 1) == 0\n",
    );
    assert!(
        out[0].1.is_some(),
        "a negative index is as much a defect as one past the end"
    );
}

#[test]
fn reading_any_element_of_an_empty_list_is_reported() {
    // The list is given an element type by a push that is then dropped:
    // a bare `list()` has no decided element type, which the checker
    // rightly refuses before any of this can be reached.
    let out = run(
        "fn empty() List<i32>\n  return list()\n\ntest \"t\"\n  throw \"unreachable\" unless at(list: empty(), index: 0) == 0\n",
    );
    assert!(
        out[0].1.is_some(),
        "an empty list has no element 0, and the null elements pointer must not be followed"
    );
}

#[test]
fn a_fault_outranks_a_test_that_reported_nothing() {
    // The case that makes this worth reporting at all. The test reads
    // past the end, gets a zero that was never in the list, and its
    // assertion HOLDS — so without the fault it would pass, green, on a
    // value it invented.
    let out = run(
        "test \"t\"\n  let xs = push(list: list(), value: 7)\n  throw \"the invented element should be zero\" unless at(list: xs, index: 4) == 0\n",
    );
    assert!(
        out[0].1.is_some(),
        "the test asserted successfully on a value it read out of range; that is not a pass"
    );
}

#[test]
fn a_fault_does_not_leak_into_the_next_test() {
    // The arena is reset between tests and the fault goes with it.
    // Otherwise one bad read would paint every later test red and the
    // real one would be impossible to find.
    let out = run(
        "fn empty() List<i32>\n  return list()\n\ntest \"bad\"\n  throw \"unreachable\" unless at(list: empty(), index: 0) == 0\n\ntest \"good\"\n  throw \"two and two\" unless 2 + 2 == 4\n",
    );
    assert!(out[0].1.is_some(), "the first test read out of range");
    assert_eq!(out[1].1, None, "the second test did nothing wrong");
}
