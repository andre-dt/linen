// =====================================================================
// packages/kernel-occt/native/include/linen.h
//
// The C boundary between Rust and OCCT.
//
// C++ OWNS NO STATE. There is no session here, no registry, no mutex:
// the shape registry, the per-session lock and every buffer live in
// Rust, where ownership is checked by the compiler rather than by
// review.
//
// That split is the whole point. OCCT itself is twenty-five-year-old,
// heavily exercised code — its remaining memory bugs are not the ones
// we will hit. The bugs that matter live in the code written this
// week: the registry, the lifetime bookkeeping, the lock discipline.
// Keeping that in Rust makes a forgotten check a compile error, rather
// than an invalid TopoDS_Shape reaching OCCT — which segfaults and
// takes every other session on the server down with it.
//
// What remains here is a pure function library: shapes in, shapes out.
//
// Narrow in SURFACE, thick in PAYLOAD. Every crossing costs, so we
// pass whole arrays rather than looping on the Rust side:
//
//   wrong:  for (edge in edges) fillet_edge(body, edge, radius)
//   right:  fillet(body, edges, radii, count)
// =====================================================================

#ifndef LINEN_H
#define LINEN_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// =====================================================================
// OPAQUE SHAPES
// =====================================================================
// A heap-allocated TopoDS_Shape. Rust holds these in its registry and
// hands out integer ids to TypeScript; no OCCT type is ever named
// outside this header.
//
// Every shape returned below is owned by the CALLER and released with
// linen_shape_free. Rust's Drop does that automatically — exactly the
// guarantee a C++ registry could not give us.

typedef void* linen_shape;

void linen_shape_free(linen_shape shape);

/// Deep copy, for when one shape feeds two operations: OCCT operations
/// may consume or mutate their input.
linen_shape linen_shape_clone(linen_shape shape);

/// True when `entity` is part of `body`.
///
/// CadQuery carries a live `TODO: we segfault` for skipping this check
/// in its fillet path. Across our boundary an entity from the wrong
/// body would do the same, so every local operation asks first.
int linen_shape_contains(linen_shape body, linen_shape entity);

// =====================================================================
// ERRORS AS VALUES
// =====================================================================
// A C++ exception must NEVER escape into N-API: it would tear down the
// process. Every entry point wraps its body in LINEN_GUARD, which
// converts Standard_Failure into this struct.
//
// The message is a heap buffer owned by the CALLER. Rust copies it
// into a String and calls linen_string_free — no "valid until the next
// call" contract, because that is precisely the sort of contract that
// turns into a use-after-free.

typedef enum {
  LINEN_OK = 0,
  LINEN_OPERATION_FAILED = 1,
  LINEN_INVALID_INPUT = 2,
  LINEN_UNSUPPORTED = 3,
  LINEN_INTERNAL = 4,
} linen_status;

typedef struct {
  linen_status status;
  /// Null when status is LINEN_OK. Otherwise owned by the caller.
  char* message;
} linen_error;

void linen_string_free(char* message);

// =====================================================================
// SKETCH
// =====================================================================
// Curves arrive as one flat packed buffer rather than a struct array:
// zero-copy from the Float64Array on the JavaScript side, and one
// crossing instead of one per curve.
//
//   [kind, param_count, params...] repeated
//
//   kind 0 line     x1 y1 x2 y2
//   kind 1 arc      x1 y1 x2 y2 bulge
//   kind 2 circle   cx cy radius
//   kind 3 ellipse  cx cy rx ry rotation
//   kind 4 spline   count x1 y1 x2 y2 ...

typedef struct {
  const double* curves;
  size_t curve_count;
  double origin[3];
  double normal[3];
  double x_direction[3];
} linen_sketch_input;

linen_error linen_sketch_build(
  const linen_sketch_input* input,
  linen_shape* out_face);

// =====================================================================
// EXTRUDE
// =====================================================================
// Expressions are already resolved: the boundary only sees numbers.

typedef struct {
  linen_shape profile;
  /// A zero vector means "use the sketch normal".
  double direction[3];
  double forward;
  double backward;
  double taper;
} linen_extrude_input;

typedef enum {
  LINEN_ROLE_START = 0,
  LINEN_ROLE_END = 1,
  LINEN_ROLE_SIDE = 2,
} linen_face_role;

/**
 * Faces come back as parallel arrays in a DETERMINISTIC order.
 *
 * Stable ordering is what lets a stored selector survive a parameter
 * change. It is the problem CadQuery never solved: there, equality is
 * OCCT pointer identity and every boolean regenerates the shapes, so
 * `>Z[-2]` can silently pick a different face after an edit and yield
 * a solid that is valid and wrong, with no error anywhere.
 *
 * Both arrays are allocated here and released with linen_faces_free.
 */
typedef struct {
  linen_shape body;
  linen_shape* faces;
  uint8_t* roles; // one linen_face_role per entry
  size_t face_count;
} linen_extrude_output;

linen_error linen_extrude(
  const linen_extrude_input* input,
  linen_extrude_output* out_result);

void linen_faces_free(linen_extrude_output* result);

// =====================================================================
// BOOLEANS
// =====================================================================

typedef enum {
  LINEN_BOOLEAN_UNION = 0,
  LINEN_BOOLEAN_SUBTRACT = 1,
  LINEN_BOOLEAN_INTERSECT = 2,
} linen_boolean_kind;

linen_error linen_boolean(
  linen_boolean_kind kind,
  linen_shape first,
  linen_shape second,
  linen_shape* out_body);

// =====================================================================
// TESSELLATION
// =====================================================================
// The largest payload in the system, so it is a SINGLE buffer laid out
// exactly as src/common/kernel.ts documents. Those same bytes travel
// to the socket and into the GPU buffer with no re-serialization: one
// format, three consumers.
//
// `faces` and `face_ids` let the CALLER supply the identifier mapping,
// rather than C++ inventing identifiers it has no way to keep stable
// across regenerations.
//
// The buffer is allocated here and released with linen_mesh_free.

typedef struct {
  uint8_t* data;
  size_t length;
} linen_mesh;

linen_error linen_tessellate(
  linen_shape body,
  const linen_shape* faces,
  const uint32_t* face_ids,
  size_t face_count,
  double linear_tolerance,
  double angular_tolerance,
  linen_mesh* out_mesh);

void linen_mesh_free(linen_mesh* mesh);

#ifdef __cplusplus
}
#endif

#endif // LINEN_H
