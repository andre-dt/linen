// =====================================================================
// drivers/brep.rs — THE BOUNDARY REPRESENTATION.
//
// The implementation behind `src/drivers/brep.lang`, which declares
// these signatures and no bodies. This is what goes into liblinen.a.
//
// A solid described by its BOUNDARY: the faces that separate inside
// from outside, the edges where faces meet, the vertices where edges
// meet. Not a soup of triangles — a triangle soup does not know that
// two triangles share an edge, and every operation a kernel performs is
// about exactly that.
//
//   Body   ── Face  ── Loop  ── CoEdge ── Edge ── Vertex
//                        │        │        │
//                    a plane   direction  two vertices
//
// WHY EACH LEVEL EXISTS
// ---------------------
//   Vertex   a point, shared by every edge that ends there
//   Edge     two vertices, shared by the TWO faces meeting along it
//   CoEdge   an edge as ONE face uses it, with a direction
//   Loop     a closed circuit of coedges, bounding one face
//   Face     a loop and the plane it lies in
//   Body     the faces that together enclose a volume
//
// The CoEdge is the one that looks redundant and is not. An edge is
// shared by two faces, and each traverses it in the OPPOSITE direction
// — that is what makes both loops wind counter-clockwise seen from
// outside their own face. Without it, an edge would need to know which
// of its two faces was asking.
//
// WHY INDICES AND NOT REFERENCES
// ------------------------------
// A Face holds the INDEX of its loop, not the loop itself. Topology is
// cyclic — a face refers to an edge that refers back to the face — and
// a value that contained itself could not be built at all. Indices
// break the cycle without a pointer, and they are what STEP writes too.
//
// WHY A BODY IS A HANDLE
// ----------------------
// `Body` crosses the boundary as an i32 into the registry below, never
// as a struct. A body holding five growable lists would make its
// layout a contract between the two sides, and getting that wrong is
// silent corruption rather than a crash.
//
// The cost is that a body must be released explicitly. Nothing here is
// collected: a handle outlives the call that built it until `release`,
// which is what makes a body usable across several calls at all.
// =====================================================================

use std::cell::RefCell;
use std::collections::HashMap;

/// A body handle, as the compiled code sees it.
///
/// Repr C and one field, so it crosses as a plain i32 — which is the
/// whole point. The shape exists in the language for the name.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct BodyHandle {
    pub id: i32,
}

/// A vertex, crossing by value.
///
/// Three i32s, no padding, no pointer — the one aggregate small and
/// flat enough that every ABI agrees on it. Anything larger goes back
/// as an index instead.
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct VertexValue {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

#[derive(Clone, Copy)]
struct Edge {
    from: i32,
    to: i32,
}

#[derive(Clone, Copy)]
struct CoEdge {
    edge: i32,
    forward: bool,
}

#[derive(Default)]
struct Loop {
    coedges: Vec<i32>,
}

#[derive(Clone, Copy)]
struct Face {
    outer: i32,
    /// Three of the face's own vertices, in loop order, naming its
    /// plane.
    ///
    /// Three points ARE a plane, they are already exact integers, and a
    /// normal would be a direction that generally has no integer
    /// representation. In loop order, because the orientation is what
    /// decides which way the face points.
    a: i32,
    b: i32,
    c: i32,
}

#[derive(Default)]
struct BodyData {
    vertices: Vec<VertexValue>,
    edges: Vec<Edge>,
    coedges: Vec<CoEdge>,
    loops: Vec<Loop>,
    faces: Vec<Face>,
}

/// Every live body, by handle.
///
/// A registry rather than leaked pointers: an invalid handle reads as a
/// missing key, which is recoverable, where a stale pointer is not.
struct Registry {
    bodies: HashMap<i32, BodyData>,
    /// Never reused, so a handle released and then used again does not
    /// silently address a different body.
    next: i32,
}

thread_local! {
    static REGISTRY: RefCell<Registry> = RefCell::new(Registry {
        bodies: HashMap::new(),
        next: 1,
    });
}

/// Throws away every body. Called between tests, with the arena.
///
/// Without it a test suite would carry every body it ever built, and a
/// test that forgot to release would affect the next one's handles.
pub fn reset() {
    REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        registry.bodies.clear();
        registry.next = 1;
    });
}

/// Reads from a body, giving `fallback` when the handle is not live.
///
/// A dead handle is a defect in the caller, and it will show up as a
/// wrong answer in a test rather than a crash — which is the right
/// trade at a C boundary, where a panic is undefined behaviour.
fn read<T>(body: BodyHandle, fallback: T, of: impl Fn(&BodyData) -> T) -> T {
    REGISTRY.with(|registry| {
        registry
            .borrow()
            .bodies
            .get(&body.id)
            .map(of)
            .unwrap_or(fallback)
    })
}

/// Changes a body, giving -1 when the handle is not live.
fn write(body: BodyHandle, of: impl FnOnce(&mut BodyData) -> i32) -> i32 {
    REGISTRY.with(|registry| {
        registry
            .borrow_mut()
            .bodies
            .get_mut(&body.id)
            .map(of)
            .unwrap_or(-1)
    })
}

/// Every driver in this module, for the JIT and the linker.
pub fn table() -> Vec<(&'static str, usize)> {
    vec![
        ("empty_body", linen_empty_body as *const () as usize),
        ("add_vertex", linen_add_vertex as *const () as usize),
        ("add_edge", linen_add_edge as *const () as usize),
        ("add_coedge", linen_add_coedge as *const () as usize),
        ("add_loop", linen_add_loop as *const () as usize),
        ("extend_loop", linen_extend_loop as *const () as usize),
        ("add_face", linen_add_face as *const () as usize),
        ("vertex_count", linen_vertex_count as *const () as usize),
        ("edge_count", linen_edge_count as *const () as usize),
        ("coedge_count", linen_coedge_count as *const () as usize),
        ("loop_count", linen_loop_count as *const () as usize),
        ("face_count", linen_face_count as *const () as usize),
        ("vertex_x", linen_vertex_x as *const () as usize),
        ("vertex_y", linen_vertex_y as *const () as usize),
        ("vertex_z", linen_vertex_z as *const () as usize),
        ("edge_from", linen_edge_from as *const () as usize),
        ("edge_to", linen_edge_to as *const () as usize),
        ("coedge_edge", linen_coedge_edge as *const () as usize),
        ("coedge_forward", linen_coedge_forward as *const () as usize),
        ("coedge_start", linen_coedge_start as *const () as usize),
        ("coedge_end", linen_coedge_end as *const () as usize),
        ("loop_size", linen_loop_size as *const () as usize),
        ("loop_coedge", linen_loop_coedge as *const () as usize),
        ("face_outer", linen_face_outer as *const () as usize),
        ("face_a", linen_face_a as *const () as usize),
        ("face_b", linen_face_b as *const () as usize),
        ("face_c", linen_face_c as *const () as usize),
        ("release", linen_release as *const () as usize),
    ]
}

// =====================================================================
// building
// =====================================================================

#[no_mangle]
pub extern "C" fn linen_empty_body() -> BodyHandle {
    REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        let id = registry.next;
        registry.next += 1;
        registry.bodies.insert(id, BodyData::default());
        BodyHandle { id }
    })
}

#[no_mangle]
pub extern "C" fn linen_add_vertex(body: BodyHandle, x: i32, y: i32, z: i32) -> i32 {
    write(body, |data| {
        data.vertices.push(VertexValue { x, y, z });
        (data.vertices.len() - 1) as i32
    })
}

#[no_mangle]
pub extern "C" fn linen_add_edge(body: BodyHandle, from: i32, to: i32) -> i32 {
    write(body, |data| {
        data.edges.push(Edge { from, to });
        (data.edges.len() - 1) as i32
    })
}

#[no_mangle]
pub extern "C" fn linen_add_coedge(body: BodyHandle, edge: i32, forward: bool) -> i32 {
    write(body, |data| {
        data.coedges.push(CoEdge { edge, forward });
        (data.coedges.len() - 1) as i32
    })
}

#[no_mangle]
pub extern "C" fn linen_add_loop(body: BodyHandle) -> i32 {
    write(body, |data| {
        data.loops.push(Loop::default());
        (data.loops.len() - 1) as i32
    })
}

#[no_mangle]
pub extern "C" fn linen_extend_loop(body: BodyHandle, ring: i32, coedge: i32) {
    write(body, |data| {
        if let Some(found) = data.loops.get_mut(ring.max(0) as usize) {
            found.coedges.push(coedge);
        }
        0
    });
}

#[no_mangle]
pub extern "C" fn linen_add_face(body: BodyHandle, outer: i32, a: i32, b: i32, c: i32) -> i32 {
    write(body, |data| {
        data.faces.push(Face { outer, a, b, c });
        (data.faces.len() - 1) as i32
    })
}

// =====================================================================
// reading
// =====================================================================

#[no_mangle]
pub extern "C" fn linen_vertex_count(body: BodyHandle) -> i32 {
    read(body, 0, |data| data.vertices.len() as i32)
}

#[no_mangle]
pub extern "C" fn linen_edge_count(body: BodyHandle) -> i32 {
    read(body, 0, |data| data.edges.len() as i32)
}

#[no_mangle]
pub extern "C" fn linen_coedge_count(body: BodyHandle) -> i32 {
    read(body, 0, |data| data.coedges.len() as i32)
}

#[no_mangle]
pub extern "C" fn linen_loop_count(body: BodyHandle) -> i32 {
    read(body, 0, |data| data.loops.len() as i32)
}

#[no_mangle]
pub extern "C" fn linen_face_count(body: BodyHandle) -> i32 {
    read(body, 0, |data| data.faces.len() as i32)
}

/// A vertex, one coordinate at a time.
///
/// Not as a struct. A three-i32 aggregate returned by value crosses
/// the SysV ABI through a hidden pointer, and returning it directly
/// loses two of the three fields — silently, with the FIRST one still
/// correct, which is what makes it survive a careless test.
///
/// Zero when the index is out of range, for the same reason the other
/// readers have a fallback: a panic across the C ABI is undefined
/// behaviour, and a wrong answer surfaces in a test with a name on it.
#[no_mangle]
pub extern "C" fn linen_vertex_x(body: BodyHandle, index: i32) -> i32 {
    read(body, 0, |data| {
        data.vertices.get(index.max(0) as usize).map(|v| v.x).unwrap_or(0)
    })
}

#[no_mangle]
pub extern "C" fn linen_vertex_y(body: BodyHandle, index: i32) -> i32 {
    read(body, 0, |data| {
        data.vertices.get(index.max(0) as usize).map(|v| v.y).unwrap_or(0)
    })
}

#[no_mangle]
pub extern "C" fn linen_vertex_z(body: BodyHandle, index: i32) -> i32 {
    read(body, 0, |data| {
        data.vertices.get(index.max(0) as usize).map(|v| v.z).unwrap_or(0)
    })
}

#[no_mangle]
pub extern "C" fn linen_edge_from(body: BodyHandle, index: i32) -> i32 {
    read(body, -1, |data| {
        data.edges.get(index.max(0) as usize).map(|e| e.from).unwrap_or(-1)
    })
}

#[no_mangle]
pub extern "C" fn linen_edge_to(body: BodyHandle, index: i32) -> i32 {
    read(body, -1, |data| {
        data.edges.get(index.max(0) as usize).map(|e| e.to).unwrap_or(-1)
    })
}

#[no_mangle]
pub extern "C" fn linen_coedge_edge(body: BodyHandle, index: i32) -> i32 {
    read(body, -1, |data| {
        data.coedges.get(index.max(0) as usize).map(|c| c.edge).unwrap_or(-1)
    })
}

#[no_mangle]
pub extern "C" fn linen_coedge_forward(body: BodyHandle, index: i32) -> bool {
    read(body, false, |data| {
        data.coedges
            .get(index.max(0) as usize)
            .map(|c| c.forward)
            .unwrap_or(false)
    })
}

/// Where a coedge starts, for the face that owns it.
///
/// The whole reason a coedge exists: the same edge answers differently
/// depending on which face is asking.
#[no_mangle]
pub extern "C" fn linen_coedge_start(body: BodyHandle, index: i32) -> i32 {
    read(body, -1, |data| {
        let Some(coedge) = data.coedges.get(index.max(0) as usize) else {
            return -1;
        };
        let Some(edge) = data.edges.get(coedge.edge.max(0) as usize) else {
            return -1;
        };
        if coedge.forward {
            edge.from
        } else {
            edge.to
        }
    })
}

#[no_mangle]
pub extern "C" fn linen_coedge_end(body: BodyHandle, index: i32) -> i32 {
    read(body, -1, |data| {
        let Some(coedge) = data.coedges.get(index.max(0) as usize) else {
            return -1;
        };
        let Some(edge) = data.edges.get(coedge.edge.max(0) as usize) else {
            return -1;
        };
        if coedge.forward {
            edge.to
        } else {
            edge.from
        }
    })
}

#[no_mangle]
pub extern "C" fn linen_loop_size(body: BodyHandle, ring: i32) -> i32 {
    read(body, 0, |data| {
        data.loops
            .get(ring.max(0) as usize)
            .map(|found| found.coedges.len() as i32)
            .unwrap_or(0)
    })
}

#[no_mangle]
pub extern "C" fn linen_loop_coedge(body: BodyHandle, ring: i32, position: i32) -> i32 {
    read(body, -1, |data| {
        data.loops
            .get(ring.max(0) as usize)
            .and_then(|found| found.coedges.get(position.max(0) as usize))
            .copied()
            .unwrap_or(-1)
    })
}

#[no_mangle]
pub extern "C" fn linen_face_outer(body: BodyHandle, index: i32) -> i32 {
    read(body, -1, |data| {
        data.faces.get(index.max(0) as usize).map(|f| f.outer).unwrap_or(-1)
    })
}

#[no_mangle]
pub extern "C" fn linen_face_a(body: BodyHandle, index: i32) -> i32 {
    read(body, -1, |data| {
        data.faces.get(index.max(0) as usize).map(|f| f.a).unwrap_or(-1)
    })
}

#[no_mangle]
pub extern "C" fn linen_face_b(body: BodyHandle, index: i32) -> i32 {
    read(body, -1, |data| {
        data.faces.get(index.max(0) as usize).map(|f| f.b).unwrap_or(-1)
    })
}

#[no_mangle]
pub extern "C" fn linen_face_c(body: BodyHandle, index: i32) -> i32 {
    read(body, -1, |data| {
        data.faces.get(index.max(0) as usize).map(|f| f.c).unwrap_or(-1)
    })
}

#[no_mangle]
pub extern "C" fn linen_release(body: BodyHandle) {
    REGISTRY.with(|registry| {
        registry.borrow_mut().bodies.remove(&body.id);
    });
}
