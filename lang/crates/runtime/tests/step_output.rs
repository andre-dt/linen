// What a STEP file actually looks like.
//
// Less an assertion than a way to READ the output: `--nocapture` prints
// the file, and the three checks below are the parts the standard
// fixes. A format is the one thing where looking at it beats reasoning
// about it.

use runtime::drivers::brep;
use runtime::drivers::step;

#[test]
fn a_triangle_writes_a_readable_file() {
    let body = brep::linen_empty_body();
    let a = brep::linen_add_vertex(body, 0, 0, 0);
    let b = brep::linen_add_vertex(body, 100, 0, 0);
    let c = brep::linen_add_vertex(body, 0, 100, 0);
    let ab = brep::linen_add_edge(body, a, b);
    let bc = brep::linen_add_edge(body, b, c);
    let ca = brep::linen_add_edge(body, c, a);
    let ring = brep::linen_add_loop(body);
    brep::linen_extend_loop(body, ring, brep::linen_add_coedge(body, ab, true));
    brep::linen_extend_loop(body, ring, brep::linen_add_coedge(body, bc, true));
    brep::linen_extend_loop(body, ring, brep::linen_add_coedge(body, ca, true));
    brep::linen_add_face(body, ring, a, b, c);

    let bytes = step::linen_serialize(body);
    let count = bytes.length as usize;
    let elements = unsafe { std::slice::from_raw_parts(bytes.elements as *const i32, count) };
    let text: String = elements.iter().map(|each| *each as u8 as char).collect();
    println!("{text}");

    assert!(text.starts_with("ISO-10303-21;"), "the standard fixes the first line");
    assert!(text.ends_with("END-ISO-10303-21;\n"), "and the last");
    assert!(text.contains("ADVANCED_FACE"), "a face should be in there");
}
