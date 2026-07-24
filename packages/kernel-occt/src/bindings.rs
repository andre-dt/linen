// =====================================================================
// packages/kernel-occt/src/bindings.rs
//
// Hand-written declarations mirroring native/include/linen.h.
//
// Written by hand rather than generated with bindgen: the boundary is
// small and stable by design, and a generator would pull in a build
// dependency on libclang for about a hundred lines of declarations.
//
// If linen.h changes, change this file. The layouts must match exactly
// — a mismatch is silent memory corruption, not a compile error.
// =====================================================================

use std::os::raw::{c_char, c_int, c_void};

pub type LinenSession = *mut c_void;
pub type LinenBodyId = u32;
pub type LinenFaceId = u32;
pub type LinenSketchId = u32;

// --- status codes: must match the enum in linen.h --------------------
pub const LINEN_OK: u32 = 0;
pub const LINEN_OPERATION_FAILED: u32 = 1;
pub const LINEN_INVALID_INPUT: u32 = 2;
pub const LINEN_UNSUPPORTED: u32 = 3;
pub const LINEN_INTERNAL: u32 = 4;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct LinenError {
    pub status: u32,
    /// Owned by the session; valid until the next call on it.
    pub message: *const c_char,
}

impl Default for LinenError {
    fn default() -> Self {
        Self { status: LINEN_OK, message: std::ptr::null() }
    }
}

// --- sketch -----------------------------------------------------------

#[repr(C)]
pub struct LinenSketchInput {
    /// Flat packed curve data; see linen.h for the encoding.
    pub curves: *const f64,
    pub curve_count: usize,
    pub origin: [f64; 3],
    pub normal: [f64; 3],
    pub x_direction: [f64; 3],
}

// --- extrude ----------------------------------------------------------

#[repr(C)]
#[derive(Default)]
pub struct LinenExtrudeInput {
    pub profile: LinenSketchId,
    /// A zero vector means "use the sketch normal".
    pub direction: [f64; 3],
    pub forward: f64,
    pub backward: f64,
    pub taper: f64,
}

#[repr(C)]
pub struct LinenExtrudeOutput {
    pub body: LinenBodyId,
    pub start_faces: *const LinenFaceId,
    pub start_count: usize,
    pub end_faces: *const LinenFaceId,
    pub end_count: usize,
    pub side_faces: *const LinenFaceId,
    pub side_count: usize,
}

impl Default for LinenExtrudeOutput {
    fn default() -> Self {
        Self {
            body: 0,
            start_faces: std::ptr::null(),
            start_count: 0,
            end_faces: std::ptr::null(),
            end_count: 0,
            side_faces: std::ptr::null(),
            side_count: 0,
        }
    }
}

// --- booleans ---------------------------------------------------------

pub const LINEN_BOOLEAN_UNION: u32 = 0;
pub const LINEN_BOOLEAN_SUBTRACT: u32 = 1;
pub const LINEN_BOOLEAN_INTERSECT: u32 = 2;

// --- mesh -------------------------------------------------------------

#[repr(C)]
pub struct LinenMesh {
    pub data: *const u8,
    pub length: usize,
}

impl Default for LinenMesh {
    fn default() -> Self {
        Self { data: std::ptr::null(), length: 0 }
    }
}

// --- the boundary -----------------------------------------------------
// Every one of these blocks on the calling thread, which is why the
// N-API layer only ever calls them from the libuv pool.

extern "C" {
    pub fn linen_session_open() -> LinenSession;
    pub fn linen_session_close(session: LinenSession);
    pub fn linen_session_release(
        session: LinenSession,
        bodies: *const LinenBodyId,
        count: usize,
    );
    pub fn linen_session_live_count(session: LinenSession) -> usize;

    pub fn linen_entity_belongs_to(
        session: LinenSession,
        body: LinenBodyId,
        face: LinenFaceId,
    ) -> c_int;

    pub fn linen_sketch_build(
        session: LinenSession,
        input: *const LinenSketchInput,
        out_sketch: *mut LinenSketchId,
    ) -> LinenError;

    pub fn linen_extrude(
        session: LinenSession,
        input: *const LinenExtrudeInput,
        out_result: *mut LinenExtrudeOutput,
    ) -> LinenError;

    pub fn linen_boolean(
        session: LinenSession,
        kind: u32,
        first: LinenBodyId,
        second: LinenBodyId,
        out_body: *mut LinenBodyId,
    ) -> LinenError;

    pub fn linen_tessellate(
        session: LinenSession,
        body: LinenBodyId,
        linear_tolerance: f64,
        angular_tolerance: f64,
        out_mesh: *mut LinenMesh,
    ) -> LinenError;

    pub fn linen_mesh_free(session: LinenSession, mesh: *mut LinenMesh);
}
