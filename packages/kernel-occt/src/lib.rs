// =====================================================================
// packages/kernel-occt/src/lib.rs
//
// The N-API surface. Thin by design: it marshals, dispatches to the
// libuv pool, and converts errors into values. All geometry lives in
// the C++ shim.
//
// THREADING
// ---------
// Kernel operations block for milliseconds and occasionally seconds.
// Every one of them runs as an async task on the libuv pool, never on
// the event loop thread — a synchronous fillet would freeze the whole
// server, not just one request.
//
// OCCT is not thread-safe across operations on the same shape, so a
// session holds a mutex: calls within a session serialize, while
// separate sessions run in parallel. Size UV_THREADPOOL_SIZE by
// expected concurrent sessions per instance.
// =====================================================================

#![deny(clippy::undocumented_unsafe_blocks)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::Mutex;
use std::sync::Arc;

mod bindings;
use bindings as ffi;

// =====================================================================
// SESSION
// =====================================================================

/// Owns every live shape for one user session. Dropping it frees all
/// native memory at once, which is why session expiry is cheap.
#[napi]
pub struct KernelSession {
    inner: Arc<Mutex<SessionHandle>>,
}

/// The raw pointer is only ever touched under the mutex above.
struct SessionHandle(ffi::LinenSession);

// SAFETY: the handle is only dereferenced while holding the mutex, and
// the C++ side keeps no thread-local state.
unsafe impl Send for SessionHandle {}

impl Drop for SessionHandle {
    fn drop(&mut self) {
        // SAFETY: the handle came from linen_session_open and is closed
        // exactly once, here.
        unsafe { ffi::linen_session_close(self.0) }
    }
}

#[napi]
impl KernelSession {
    #[napi(factory)]
    pub fn open() -> Self {
        // SAFETY: no arguments, returns an owned handle.
        let handle = unsafe { ffi::linen_session_open() };
        Self { inner: Arc::new(Mutex::new(SessionHandle(handle))) }
    }

    /// Explicit release. Nothing here waits on the JavaScript garbage
    /// collector: it never sees native memory, and OCCT holds a lot.
    #[napi]
    pub fn release(&self, bodies: Vec<u32>) {
        let guard = self.inner.lock();
        // SAFETY: pointer valid under the lock; slice outlives the call.
        unsafe { ffi::linen_session_release(guard.0, bodies.as_ptr(), bodies.len()) }
    }

    #[napi]
    pub fn live_count(&self) -> u32 {
        let guard = self.inner.lock();
        // SAFETY: pointer valid under the lock.
        unsafe { ffi::linen_session_live_count(guard.0) as u32 }
    }

    /// Guards the path CadQuery leaves open with its live
    /// `TODO: we segfault`. Across this boundary a mis-selected entity
    /// would take down the process, so callers check first.
    #[napi]
    pub fn entity_belongs_to(&self, body: u32, face: u32) -> bool {
        let guard = self.inner.lock();
        // SAFETY: pointer valid under the lock.
        unsafe { ffi::linen_entity_belongs_to(guard.0, body, face) != 0 }
    }

    // =================================================================
    // OPERATIONS
    // =================================================================
    // Each one is `async`, so napi-rs runs it on the libuv pool.

    #[napi]
    pub async fn extrude(&self, input: ExtrudeInput) -> Result<ExtrudeOutput> {
        let session = Arc::clone(&self.inner);
        run_blocking(move || {
            let guard = session.lock();
            let native = ffi::LinenExtrudeInput {
                profile: input.profile,
                direction: [input.direction_x, input.direction_y, input.direction_z],
                forward: input.forward,
                backward: input.backward,
                taper: input.taper,
            };
            let mut output = ffi::LinenExtrudeOutput::default();
            // SAFETY: pointer valid under the lock; input and output
            // both outlive the call.
            let error = unsafe { ffi::linen_extrude(guard.0, &native, &mut output) };
            check(error)?;

            Ok(ExtrudeOutput {
                body: output.body,
                // SAFETY: the C++ side guarantees these arrays hold the
                // reported counts and stay valid until released.
                start_faces: unsafe { collect_ids(output.start_faces, output.start_count) },
                end_faces: unsafe { collect_ids(output.end_faces, output.end_count) },
                side_faces: unsafe { collect_ids(output.side_faces, output.side_count) },
            })
        })
        .await
    }

    /// Returns the packed mesh buffer verbatim. Those bytes reach the
    /// socket and the GPU without being re-encoded: one format, three
    /// consumers.
    #[napi]
    pub async fn tessellate(
        &self,
        body: u32,
        linear_tolerance: f64,
        angular_tolerance: f64,
    ) -> Result<Buffer> {
        let session = Arc::clone(&self.inner);
        run_blocking(move || {
            let guard = session.lock();
            let mut mesh = ffi::LinenMesh::default();
            // SAFETY: pointer valid under the lock.
            let error = unsafe {
                ffi::linen_tessellate(guard.0, body, linear_tolerance, angular_tolerance, &mut mesh)
            };
            check(error)?;

            // One copy, here. Handing JavaScript a view into native
            // memory would tie the buffer's lifetime to the session,
            // and a stale view after release is a use-after-free.
            // SAFETY: data and length come from a successful call.
            let bytes = unsafe { std::slice::from_raw_parts(mesh.data, mesh.length) }.to_vec();
            // SAFETY: frees the buffer we just copied out of.
            unsafe { ffi::linen_mesh_free(guard.0, &mut mesh) };
            Ok(bytes.into())
        })
        .await
    }
}

// =====================================================================
// MARSHALLING
// =====================================================================
// Small parameters convert field by field: readability wins and the
// payload is tiny. Bulk geometry travels as typed arrays, and meshes as
// one buffer. Three kinds of data, three treatments.

#[napi(object)]
pub struct ExtrudeInput {
    pub profile: u32,
    pub direction_x: f64,
    pub direction_y: f64,
    pub direction_z: f64,
    pub forward: f64,
    pub backward: f64,
    pub taper: f64,
}

#[napi(object)]
pub struct ExtrudeOutput {
    pub body: u32,
    /// Faces by role, in the deterministic order the C++ side
    /// establishes. Stable ordering is what lets a stored selector
    /// survive a parameter change.
    pub start_faces: Vec<u32>,
    pub end_faces: Vec<u32>,
    pub side_faces: Vec<u32>,
}

// SAFETY: caller guarantees `pointer` addresses `count` valid ids.
unsafe fn collect_ids(pointer: *const u32, count: usize) -> Vec<u32> {
    if pointer.is_null() || count == 0 {
        return Vec::new();
    }
    std::slice::from_raw_parts(pointer, count).to_vec()
}

/// Converts the C error struct into a Rust `Result`. A C++ exception
/// never reaches this far — the shim catches it — so this is purely a
/// value check.
fn check(error: ffi::LinenError) -> Result<()> {
    if error.status == ffi::LINEN_OK {
        return Ok(());
    }
    let message = if error.message.is_null() {
        "native failure".to_string()
    } else {
        // SAFETY: non-null message points at a session-owned C string
        // that stays valid until the next call on that session.
        unsafe { std::ffi::CStr::from_ptr(error.message) }
            .to_string_lossy()
            .into_owned()
    };
    Err(Error::new(status_to_napi(error.status), message))
}

fn status_to_napi(status: u32) -> Status {
    match status {
        ffi::LINEN_INVALID_INPUT => Status::InvalidArg,
        ffi::LINEN_UNSUPPORTED => Status::GenericFailure,
        _ => Status::GenericFailure,
    }
}

async fn run_blocking<T, F>(work: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    napi::tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| Error::from_reason(format!("kernel task panicked: {error}")))?
}
