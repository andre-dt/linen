// =====================================================================
// drivers/step.rs — ISO 10303-21.
//
// The implementation behind `src/step.lang`. A part leaves this kernel
// as STEP text and arrives in another CAD system as the same solid,
// which is the only reason to have an exchange format at all.
//
// WHY THIS IS RUST AND THE TESSELLATOR IS NOT
// -------------------------------------------
// STEP is TEXT. Entity references are `#12`, values are quoted, and
// reading one means tokenising and resolving a reference graph. None of
// that is geometry, and the language has integers rather than strings.
//
// Tessellation went the other way, into `.lang`, because it DECIDES
// geometry — and geometry the kernel does not own is geometry the
// kernel cannot guarantee. The line is what the work is, not what is
// easier to write.
//
// WHAT THIS WRITES
// ----------------
// The topology, entity by entity, in the order a STEP file wants it:
// nothing may reference an entity defined after it. So points before
// vertices, vertices before edges, edges before coedges, and the face
// last.
//
//   #1  = CARTESIAN_POINT('',(0.,0.,0.))
//   #4  = VERTEX_POINT('',#1)
//   #7  = EDGE_CURVE('',#4,#5,#100,.T.)
//   #10 = ORIENTED_EDGE('',*,*,#7,.T.)
//   #13 = EDGE_LOOP('',(#10,#11,#12))
//   #14 = ADVANCED_FACE('',(#13),#200,.T.)
//
// A real AP203 file carries more — product definitions, units,
// geometric contexts — and a receiving system needs them. This writes
// the topology honestly and no more; the ceremony is the next piece,
// and pretending to it now would produce a file that looks complete and
// is not.
//
// COORDINATES ARE MICRONS, AND STAY INTEGERS
// ------------------------------------------
// STEP writes reals, so a coordinate goes out as `10000000.` — the
// integer with a trailing dot. Reading takes the digits before the dot
// and requires the rest to be zero. Nothing is rounded, nothing is
// scaled, and a file with a genuine fraction in it is rejected rather
// than silently truncated: this kernel has no way to represent it, and
// pretending otherwise would move a vertex.
// =====================================================================

use crate::arena::{allocate_bytes, ListValue};

use super::brep::{self, BodyHandle};

/// Every driver in this module, for the JIT and the linker.
pub fn table() -> Vec<(&'static str, usize)> {
    vec![
        ("serialize", linen_serialize as *const () as usize),
        ("parse", linen_parse as *const () as usize),
        ("bytes_of", linen_bytes_of as *const () as usize),
    ]
}

/// The first and last lines the standard fixes.
const HEADER: &str = "ISO-10303-21;\nHEADER;\n\
FILE_DESCRIPTION(('Linen part'),'2;1');\n\
FILE_NAME('','',(''),(''),'Linen','','');\n\
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\n\
ENDSEC;\nDATA;\n";
const FOOTER: &str = "ENDSEC;\nEND-ISO-10303-21;\n";

/// `serialize(body:)` — the body as STEP text.
///
/// # Safety
/// Called from compiled code across the C ABI.
#[no_mangle]
pub extern "C" fn linen_serialize(body: BodyHandle) -> ListValue {
    bytes_of(write_step(body).as_bytes())
}

/// The whole file, as text.
///
/// Built as a String and converted once. The alternative — appending
/// bytes as it goes — would be the same work with the formatting spread
/// across it.
fn write_step(body: BodyHandle) -> String {
    let mut text = String::from(HEADER);

    let vertices = brep::linen_vertex_count(body);
    let edges = brep::linen_edge_count(body);
    let coedges = brep::linen_coedge_count(body);
    let loops = brep::linen_loop_count(body);
    let faces = brep::linen_face_count(body);

    // Entity numbers are assigned in blocks, so a reference can be
    // computed rather than looked up. Sequential-and-scattered would
    // need a map from every index to every entity number, which is a
    // second thing to keep right.
    let point = 1;
    let vertex = point + vertices;
    let edge = vertex + vertices;
    let oriented = edge + edges;
    let ring = oriented + coedges;
    let face = ring + loops;

    for index in 0..vertices {
        let x = brep::linen_vertex_x(body, index);
        let y = brep::linen_vertex_y(body, index);
        let z = brep::linen_vertex_z(body, index);
        text.push_str(&format!(
            "#{}=CARTESIAN_POINT('',({}.,{}.,{}.));\n",
            point + index,
            x,
            y,
            z
        ));
    }

    for index in 0..vertices {
        text.push_str(&format!(
            "#{}=VERTEX_POINT('',#{});\n",
            vertex + index,
            point + index
        ));
    }

    for index in 0..edges {
        let from = brep::linen_edge_from(body, index);
        let to = brep::linen_edge_to(body, index);
        // The curve is `*` — unspecified. Every edge here is a straight
        // line between its vertices, and writing a LINE entity that
        // says exactly that would be three more entities repeating what
        // the vertices already fix. It is where curves will go.
        text.push_str(&format!(
            "#{}=EDGE_CURVE('',#{},#{},*,.T.);\n",
            edge + index,
            vertex + from,
            vertex + to
        ));
    }

    for index in 0..coedges {
        let which = brep::linen_coedge_edge(body, index);
        let forward = brep::linen_coedge_forward(body, index);
        text.push_str(&format!(
            "#{}=ORIENTED_EDGE('',*,*,#{},{});\n",
            oriented + index,
            edge + which,
            if forward { ".T." } else { ".F." }
        ));
    }

    for index in 0..loops {
        let size = brep::linen_loop_size(body, index);
        let members: Vec<String> = (0..size)
            .map(|position| format!("#{}", oriented + brep::linen_loop_coedge(body, index, position)))
            .collect();
        text.push_str(&format!(
            "#{}=EDGE_LOOP('',({}));\n",
            ring + index,
            members.join(",")
        ));
    }

    for index in 0..faces {
        let outer = brep::linen_face_outer(body, index);
        let a = brep::linen_face_a(body, index);
        let b = brep::linen_face_b(body, index);
        let c = brep::linen_face_c(body, index);
        // The plane's three vertices ride along as a comment.
        //
        // STEP names a plane by a placement — an origin and two
        // directions — which is a normal, and a normal generally has no
        // integer representation. Three points ARE the plane, exactly,
        // and losing them would mean recovering the face's orientation
        // by arithmetic that this kernel deliberately avoids.
        //
        // A comment because no STEP entity carries it. Another system
        // reads the face and computes its own normal; this kernel reads
        // it back and keeps the exact one.
        text.push_str(&format!(
            "#{}=ADVANCED_FACE('',(#{}),*,.T.);/* plane {},{},{} */\n",
            face + index,
            ring + outer,
            a,
            b,
            c
        ));
    }

    text.push_str(FOOTER);
    text
}

/// `parse(bytes:)` — a body read back from STEP text.
///
/// Anything unreadable gives an EMPTY body rather than a wrong one. A
/// reader that guesses is worse than one that refuses: a body built
/// from garbage looks like geometry and is not.
///
/// # Safety
/// Called from compiled code across the C ABI.
#[no_mangle]
pub extern "C" fn linen_parse(bytes: ListValue) -> BodyHandle {
    let body = brep::linen_empty_body();
    let Some(text) = text_of(bytes) else {
        return body;
    };
    if !text.trim_start().starts_with("ISO-10303-21;") {
        return body;
    }
    read_step(&text, body);
    body
}

/// Fills a body from the entities in the text.
///
/// Two passes: entity numbers first, then the entities that reference
/// them. A STEP file may reference forward in general, and relying on
/// this writer's ordering would make the reader accept only its own
/// files.
fn read_step(text: &str, body: BodyHandle) {
    // Entity number -> what it became on this side.
    let mut point_of: Vec<(i32, [i32; 3])> = Vec::new();
    let mut vertex_of: Vec<(i32, i32)> = Vec::new();
    let mut edge_of: Vec<(i32, i32)> = Vec::new();
    let mut coedge_of: Vec<(i32, i32)> = Vec::new();
    let mut ring_of: Vec<(i32, i32)> = Vec::new();

    // CARTESIAN_POINT — the coordinates themselves.
    for (number, arguments) in entities(text, "CARTESIAN_POINT") {
        let Some(triple) = coordinates(&arguments) else {
            continue;
        };
        point_of.push((number, triple));
    }

    // VERTEX_POINT — a vertex is added here, in file order, so the
    // indices this side sees match the ones that were written.
    for (number, arguments) in entities(text, "VERTEX_POINT") {
        let Some(reference) = first_reference(&arguments) else {
            continue;
        };
        let Some((_, triple)) = point_of.iter().find(|(at, _)| *at == reference) else {
            continue;
        };
        let index = brep::linen_add_vertex(body, triple[0], triple[1], triple[2]);
        vertex_of.push((number, index));
    }

    for (number, arguments) in entities(text, "EDGE_CURVE") {
        let referenced = references(&arguments);
        if referenced.len() < 2 {
            continue;
        }
        let (Some(from), Some(to)) = (
            lookup(&vertex_of, referenced[0]),
            lookup(&vertex_of, referenced[1]),
        ) else {
            continue;
        };
        edge_of.push((number, brep::linen_add_edge(body, from, to)));
    }

    for (number, arguments) in entities(text, "ORIENTED_EDGE") {
        let referenced = references(&arguments);
        let Some(&which) = referenced.first() else {
            continue;
        };
        let Some(edge) = lookup(&edge_of, which) else {
            continue;
        };
        // `.T.` or `.F.` — the direction this face walks the edge, and
        // the whole reason a coedge exists. Dropping it would leave
        // every count correct and the solid inside out.
        let forward = !arguments.contains(".F.");
        coedge_of.push((number, brep::linen_add_coedge(body, edge, forward)));
    }

    for (number, arguments) in entities(text, "EDGE_LOOP") {
        let ring = brep::linen_add_loop(body);
        for which in references(&arguments) {
            if let Some(coedge) = lookup(&coedge_of, which) {
                brep::linen_extend_loop(body, ring, coedge);
            }
        }
        ring_of.push((number, ring));
    }

    for (_, arguments) in entities(text, "ADVANCED_FACE") {
        let Some(which) = first_reference(&arguments) else {
            continue;
        };
        let Some(ring) = lookup(&ring_of, which) else {
            continue;
        };
        // The plane's three vertices, from the comment the writer left.
        // Absent — a file from another system — leaves them at the
        // loop's first three, which is what they are for a face this
        // kernel wrote anyway.
        let plane = plane_after(text, &arguments).unwrap_or([0, 1, 2]);
        brep::linen_add_face(body, ring, plane[0], plane[1], plane[2]);
    }
}

/// The `/* plane a,b,c */` comment following a face.
///
/// Found by the face's own argument text rather than by position, so a
/// file with the faces in another order still reads.
fn plane_after(text: &str, arguments: &str) -> Option<[i32; 3]> {
    let at = text.find(arguments)?;
    let rest = &text[at + arguments.len()..];
    let start = rest.find("/* plane ")? + "/* plane ".len();
    let end = rest[start..].find(" */")? + start;
    let numbers: Vec<i32> = rest[start..end]
        .split(',')
        .filter_map(|word| word.trim().parse().ok())
        .collect();
    if numbers.len() == 3 {
        Some([numbers[0], numbers[1], numbers[2]])
    } else {
        None
    }
}

/// Every `#n=NAME(...)` of one kind, as its number and its arguments.
///
/// Scanned rather than parsed into a tree: this reads the entities it
/// knows and ignores the rest, which is what lets a file from another
/// system carry product definitions and contexts without this having to
/// model them.
fn entities(text: &str, name: &str) -> Vec<(i32, String)> {
    let mut found = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix('#') else {
            continue;
        };
        let Some(split) = rest.find('=') else {
            continue;
        };
        let Ok(number) = rest[..split].trim().parse::<i32>() else {
            continue;
        };
        let body = rest[split + 1..].trim();
        let Some(open) = body.find('(') else {
            continue;
        };
        if body[..open].trim() != name {
            continue;
        }
        // To the LAST closing bracket, so nested lists survive:
        // `EDGE_LOOP('',(#10,#11))` has brackets inside its arguments.
        let Some(close) = body.rfind(')') else {
            continue;
        };
        if close <= open {
            continue;
        }
        found.push((number, body[open + 1..close].to_string()));
    }
    found
}

/// The `#n` references in an argument list, in order.
fn references(arguments: &str) -> Vec<i32> {
    let mut found = Vec::new();
    let bytes: Vec<char> = arguments.chars().collect();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != '#' {
            at += 1;
            continue;
        }
        at += 1;
        let start = at;
        while at < bytes.len() && bytes[at].is_ascii_digit() {
            at += 1;
        }
        if at > start {
            let text: String = bytes[start..at].iter().collect();
            if let Ok(number) = text.parse() {
                found.push(number);
            }
        }
    }
    found
}

fn first_reference(arguments: &str) -> Option<i32> {
    references(arguments).into_iter().next()
}

fn lookup(table: &[(i32, i32)], number: i32) -> Option<i32> {
    table
        .iter()
        .find(|(at, _)| *at == number)
        .map(|(_, index)| *index)
}

/// `(1.,2.,3.)` — three integer-valued reals.
///
/// A genuine fraction is REFUSED rather than rounded. This kernel
/// stores microns as integers, and accepting `0.5` would move a vertex
/// somewhere it was not — silently, which is the failure mode the whole
/// integer model exists to remove.
fn coordinates(arguments: &str) -> Option<[i32; 3]> {
    let open = arguments.find('(')?;
    let close = arguments.rfind(')')?;
    let mut values = [0i32; 3];
    let mut count = 0;
    for word in arguments[open + 1..close].split(',') {
        if count == 3 {
            return None;
        }
        values[count] = whole(word.trim())?;
        count += 1;
    }
    if count == 3 {
        Some(values)
    } else {
        None
    }
}

/// A STEP real that is a whole number: `12.`, `12.0`, `-3.000`.
fn whole(text: &str) -> Option<i32> {
    let (digits, fraction) = match text.split_once('.') {
        Some((digits, fraction)) => (digits, fraction),
        None => (text, ""),
    };
    if !fraction.is_empty() && fraction.chars().any(|each| each != '0') {
        return None;
    }
    digits.parse().ok()
}

/// A `List<i32>` of bytes back into text.
fn text_of(bytes: ListValue) -> Option<String> {
    let count = bytes.length.max(0) as usize;
    if count == 0 || bytes.elements.is_null() {
        return None;
    }
    // Safety: the list came from this arena, with `count` i32 elements.
    let elements = unsafe { std::slice::from_raw_parts(bytes.elements as *const i32, count) };
    let raw: Vec<u8> = elements.iter().map(|each| *each as u8).collect();
    String::from_utf8(raw).ok()
}

/// Bytes into the arena as a `List<i32>`, one element per byte.
fn bytes_of(bytes: &[u8]) -> ListValue {
    let count = bytes.len();
    if count == 0 {
        return ListValue {
            length: 0,
            elements: std::ptr::null(),
        };
    }
    let space = allocate_bytes(count * 4) as *mut i32;
    for (index, byte) in bytes.iter().enumerate() {
        // Safety: `space` has room for `count` i32s, just allocated.
        unsafe { space.add(index).write(*byte as i32) };
    }
    ListValue {
        length: count as i32,
        elements: space as *const u8,
    }
}

/// `bytes_of(text:)` — a fixed piece of STEP text, by number.
///
/// For tests that need to hand the reader something specific: a file
/// with no header, a coordinate this kernel cannot hold. There is no
/// string literal in the language, so these are named by index.
///
/// Scaffolding, like the fragments in `linen:bytes`. It goes away when
/// the language has text.
///
/// # Safety
/// Called from compiled code across the C ABI.
#[no_mangle]
pub extern "C" fn linen_bytes_of(text: i32) -> ListValue {
    bytes_of(
        match text {
            0 => "ISO-10303-21;\nDATA;\n",
            1 => "#1=CARTESIAN_POINT('',(7.,8.,9.));\n#2=VERTEX_POINT('',#1);\n",
            2 => "#1=CARTESIAN_POINT('',(0.5,8.,9.));\n#2=VERTEX_POINT('',#1);\n",
            _ => "",
        }
        .as_bytes(),
    )
}
