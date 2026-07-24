// =====================================================================
// apps/kernel/occt/boolean.cpp
//
// Booleans are the operation most likely to fail on real geometry, and
// the one that invalidates every existing face reference: OCCT
// regenerates the underlying shapes, so nothing survives by pointer.
// This is exactly why our identity scheme derives names from feature
// and role instead of trusting the kernel's ordering.
// =====================================================================

#include "../linen.h"
#include "../session.hpp"

#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <TopoDS_Shape.hxx>

extern "C" linen_error linen_boolean(
    linen_session handle,
    linen_boolean_kind kind,
    linen_body_id first,
    linen_body_id second,
    linen_body_id* out_body) {
  auto* session = static_cast<linen::Session*>(handle);

  LINEN_GUARD(session, {
    const auto left = session->bodies.find(first);
    const auto right = session->bodies.find(second);
    if (left == session->bodies.end() || right == session->bodies.end()) {
      return linen::fail(session, LINEN_INVALID_INPUT, "unknown body in boolean");
    }

    TopoDS_Shape result;
    switch (kind) {
      case LINEN_BOOLEAN_UNION: {
        BRepAlgoAPI_Fuse operation(left->second, right->second);
        operation.Build();
        if (!operation.IsDone()) {
          return linen::fail(session, LINEN_OPERATION_FAILED, "union failed");
        }
        result = operation.Shape();
        break;
      }
      case LINEN_BOOLEAN_SUBTRACT: {
        BRepAlgoAPI_Cut operation(left->second, right->second);
        operation.Build();
        if (!operation.IsDone()) {
          return linen::fail(session, LINEN_OPERATION_FAILED, "subtraction failed");
        }
        result = operation.Shape();
        break;
      }
      case LINEN_BOOLEAN_INTERSECT: {
        BRepAlgoAPI_Common operation(left->second, right->second);
        operation.Build();
        if (!operation.IsDone()) {
          return linen::fail(session, LINEN_OPERATION_FAILED, "intersection failed");
        }
        result = operation.Shape();
        break;
      }
      default:
        return linen::fail(session, LINEN_INVALID_INPUT, "unknown boolean kind");
    }

    if (result.IsNull()) {
      return linen::fail(session, LINEN_OPERATION_FAILED, "boolean produced nothing");
    }

    // OCCT reports IsDone for results that are geometrically invalid.
    // Catching it here beats discovering it three features downstream,
    // where the message would point at the wrong operation.
    BRepCheck_Analyzer analyzer(result);
    if (!analyzer.IsValid()) {
      return linen::fail(session, LINEN_OPERATION_FAILED, "boolean produced an invalid solid");
    }

    const linen_body_id body = session->nextBody++;
    session->bodies[body] = result;
    *out_body = body;
    return linen::ok();
  })
}
