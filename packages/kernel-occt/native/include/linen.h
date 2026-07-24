// =====================================================================
// packages/kernel-occt/native/include/linen.h
//
// The C boundary between Rust and OCCT. Deliberately narrow in
// SURFACE and thick in PAYLOAD: every crossing costs, so we pass whole
// arrays rather than looping in Rust and calling per element.
//
//   wrong:  for (edge in edges) fillet_edge(body, edge, radius)
//   right:  fillet(body, edges, radii, count)
//
// NOTHING here exposes an OCCT type. TopoDS_Shape lives in a registry
// on the native side; callers only ever see a body_id integer.
// =====================================================================

#ifndef LINEN_H
#define LINEN_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef uint32_t linen_body_id;
typedef uint32_t linen_face_id;
typedef uint32_t linen_sketch_id;
typedef void* linen_session;

// --- errors as values -------------------------------------------------
// A C++ exception must NEVER escape into N-API: it would tear down the
// process. Every entry point below wraps its body in try/catch and
// converts Standard_Failure into this struct.

typedef enum {
  LINEN_OK = 0,
  LINEN_OPERATION_FAILED = 1,
  LINEN_INVALID_INPUT = 2,
  LINEN_UNSUPPORTED = 3,
  LINEN_INTERNAL = 4,
} linen_status;

typedef struct {
  linen_status status;
  // Owned by the session; valid until the next call on it.
  const char* message;
} linen_error;

// --- session ----------------------------------------------------------
// One session per user session. It owns every live shape, so expiry
// frees all of it at once. Release is EXPLICIT: OCCT holds a great
// deal of memory and the V8 collector never sees any of it.

linen_session linen_session_open(void);
void linen_session_close(linen_session session);
void linen_session_release(linen_session session, const linen_body_id* bodies, size_t count);
size_t linen_session_live_count(linen_session session);

// --- sketch -----------------------------------------------------------
// Curves arrive as a flat packed buffer rather than a struct array:
// zero-copy from the Float64Array on the JavaScript side.
//
//   [kind, param_count, params...] repeated
//
//   kind 0 line     x1 y1 x2 y2
//   kind 1 arc      x1 y1 x2 y2 bulge
//   kind 2 circle   cx cy radius
//   kind 3 ellipse  cx cy rx ry rotation
//   kind 4 spline   count x1 y1 x2 y2 ... closed

typedef struct {
  const double* curves;
  size_t curve_count;
  double origin[3];
  double normal[3];
  double x_direction[3];
} linen_sketch_input;

linen_error linen_sketch_build(
  linen_session session,
  const linen_sketch_input* input,
  linen_sketch_id* out_sketch);

// --- extrude ----------------------------------------------------------
// Expressions are already resolved: the boundary only ever sees
// numbers.

typedef struct {
  linen_sketch_id profile;
  // Zero vector means "use the sketch normal".
  double direction[3];
  double forward;
  double backward;
  double taper;
} linen_extrude_input;

// Face roles, in the DETERMINISTIC order the TypeScript side declares.
// Stable ordering is what lets `created(reference, "side")` survive a
// parameter change: if OCCT reordered faces between runs, every stored
// reference would silently repoint.
typedef struct {
  linen_body_id body;
  const linen_face_id* start_faces;
  size_t start_count;
  const linen_face_id* end_faces;
  size_t end_count;
  const linen_face_id* side_faces;
  size_t side_count;
} linen_extrude_output;

linen_error linen_extrude(
  linen_session session,
  const linen_extrude_input* input,
  linen_extrude_output* out_result);

// --- booleans ---------------------------------------------------------

typedef enum {
  LINEN_BOOLEAN_UNION = 0,
  LINEN_BOOLEAN_SUBTRACT = 1,
  LINEN_BOOLEAN_INTERSECT = 2,
} linen_boolean_kind;

linen_error linen_boolean(
  linen_session session,
  linen_boolean_kind kind,
  linen_body_id first,
  linen_body_id second,
  linen_body_id* out_body);

// --- tessellation -----------------------------------------------------
// The largest payload in the system, so it is a SINGLE buffer laid out
// exactly as common/kernel.ts documents. Those same bytes travel to
// the socket and into the GPU buffer with no re-serialization: one
// format, three consumers.
//
// The buffer is allocated natively and owned by the session until
// linen_mesh_free.

typedef struct {
  const uint8_t* data;
  size_t length;
} linen_mesh;

linen_error linen_tessellate(
  linen_session session,
  linen_body_id body,
  double linear_tolerance,
  double angular_tolerance,
  linen_mesh* out_mesh);

void linen_mesh_free(linen_session session, linen_mesh* mesh);

// --- validation -------------------------------------------------------
// CadQuery carries a live `TODO: we segfault` because it never checks
// this. Across our boundary that would take down the whole process, so
// callers must ask before every local operation.

int linen_entity_belongs_to(
  linen_session session,
  linen_body_id body,
  linen_face_id face);

#ifdef __cplusplus
}
#endif

#endif // LINEN_H
