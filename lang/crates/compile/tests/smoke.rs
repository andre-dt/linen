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
