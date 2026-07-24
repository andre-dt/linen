// =====================================================================
// packages/kernel-occt/native/src/sketch.cpp
//
// Turns two-dimensional curves into a planar face an extrusion can
// sweep.
//
// Curves arrive as one flat packed buffer rather than an array of
// structs: zero-copy from the Float64Array on the JavaScript side, and
// one crossing instead of one per curve.
//
//   [kind, param_count, params...] repeated
//
//   kind 0 line     x1 y1 x2 y2
//   kind 1 arc      x1 y1 x2 y2 bulge
//   kind 2 circle   cx cy radius
//   kind 3 ellipse  cx cy rx ry rotation
//   kind 4 spline   count x1 y1 ... closed
// =====================================================================

#include "linen.h"
#include "session.hpp"

#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <ShapeAnalysis_FreeBounds.hxx>
#include <TopTools_HSequenceOfShape.hxx>
#include <TopoDS.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <GeomAPI_PointsToBSpline.hxx>
#include <TColgp_Array1OfPnt.hxx>
#include <Precision.hxx>
#include <gp_Pln.hxx>
#include <gp_Ax2.hxx>
#include <gp_Ax3.hxx>
#include <gp_Circ.hxx>
#include <gp_Elips.hxx>

#include <cmath>

namespace {

enum CurveKind {
  CURVE_LINE = 0,
  CURVE_ARC = 1,
  CURVE_CIRCLE = 2,
  CURVE_ELLIPSE = 3,
  CURVE_SPLINE = 4,
};

/// Lifts a sketch-plane coordinate into world space.
gp_Pnt lift(const gp_Ax3& frame, double x, double y) {
  return gp_Pnt(frame.Location().XYZ()
                + frame.XDirection().XYZ() * x
                + frame.YDirection().XYZ() * y);
}

/// The third point of an arc, derived from the bulge factor. Bulge is
/// the tangent of a quarter of the included angle — the DXF
/// convention, chosen because it degrades gracefully: zero is a
/// straight line rather than a singularity.
gp_Pnt arcMidpoint(const gp_Ax3& frame, double x1, double y1,
                   double x2, double y2, double bulge) {
  const double midX = (x1 + x2) * 0.5;
  const double midY = (y1 + y2) * 0.5;
  const double deltaX = x2 - x1;
  const double deltaY = y2 - y1;
  // Perpendicular offset from the chord, scaled by the bulge.
  return lift(frame, midX - deltaY * bulge * 0.5, midY + deltaX * bulge * 0.5);
}

} // namespace

extern "C" linen_error linen_sketch_build(
    linen_session handle,
    const linen_sketch_input* input,
    linen_sketch_id* out_sketch) {
  auto* session = static_cast<linen::Session*>(handle);

  LINEN_GUARD(session, {
    if (input->curves == nullptr || input->curve_count == 0) {
      return linen::fail(session, LINEN_INVALID_INPUT, "sketch has no curves");
    }

    const gp_Pnt origin(input->origin[0], input->origin[1], input->origin[2]);
    const gp_Dir normal(input->normal[0], input->normal[1], input->normal[2]);
    const gp_Dir xDirection(input->x_direction[0], input->x_direction[1], input->x_direction[2]);
    const gp_Ax3 frame(origin, normal, xDirection);

    Handle(TopTools_HSequenceOfShape) edges = new TopTools_HSequenceOfShape();
    const double* cursor = input->curves;
    const double* limit = input->curves + input->curve_count;

    while (cursor < limit) {
      const int kind = static_cast<int>(*cursor++);
      const int parameterCount = static_cast<int>(*cursor++);
      if (cursor + parameterCount > limit) {
        return linen::fail(session, LINEN_INVALID_INPUT, "truncated curve buffer");
      }

      switch (kind) {
        case CURVE_LINE: {
          const gp_Pnt from = lift(frame, cursor[0], cursor[1]);
          const gp_Pnt to = lift(frame, cursor[2], cursor[3]);
          // A degenerate segment is skipped rather than rejected: it
          // is what a double-click during drawing produces.
          if (!from.IsEqual(to, Precision::Confusion())) {
            edges->Append(BRepBuilderAPI_MakeEdge(from, to).Edge());
          }
          break;
        }
        case CURVE_ARC: {
          const gp_Pnt from = lift(frame, cursor[0], cursor[1]);
          const gp_Pnt to = lift(frame, cursor[2], cursor[3]);
          const double bulge = cursor[4];
          if (std::abs(bulge) < 1e-12) {
            // Zero bulge is a straight line, not a failure.
            edges->Append(BRepBuilderAPI_MakeEdge(from, to).Edge());
            break;
          }
          const gp_Pnt middle =
            arcMidpoint(frame, cursor[0], cursor[1], cursor[2], cursor[3], bulge);
          GC_MakeArcOfCircle arc(from, middle, to);
          if (!arc.IsDone()) {
            return linen::fail(session, LINEN_INVALID_INPUT, "arc is not constructible");
          }
          edges->Append(BRepBuilderAPI_MakeEdge(arc.Value()).Edge());
          break;
        }
        case CURVE_CIRCLE: {
          const double radius = cursor[2];
          if (radius <= Precision::Confusion()) {
            return linen::fail(session, LINEN_INVALID_INPUT, "circle radius is not positive");
          }
          const gp_Circ circle(gp_Ax2(lift(frame, cursor[0], cursor[1]), normal, xDirection),
                               radius);
          edges->Append(BRepBuilderAPI_MakeEdge(circle).Edge());
          break;
        }
        case CURVE_ELLIPSE: {
          const double radiusX = cursor[2];
          const double radiusY = cursor[3];
          const double rotation = cursor[4];
          if (radiusX <= Precision::Confusion() || radiusY <= Precision::Confusion()) {
            return linen::fail(session, LINEN_INVALID_INPUT, "ellipse radius is not positive");
          }
          // OCCT requires the major radius first, so a taller ellipse
          // is built rotated a quarter turn.
          const bool swapped = radiusY > radiusX;
          gp_Ax2 axis(lift(frame, cursor[0], cursor[1]), normal, xDirection);
          axis.Rotate(gp_Ax1(axis.Location(), normal),
                      rotation + (swapped ? M_PI_2 : 0.0));
          const gp_Elips ellipse(axis,
                                 swapped ? radiusY : radiusX,
                                 swapped ? radiusX : radiusY);
          edges->Append(BRepBuilderAPI_MakeEdge(ellipse).Edge());
          break;
        }
        case CURVE_SPLINE: {
          const int pointCount = static_cast<int>(cursor[0]);
          if (pointCount < 2) {
            return linen::fail(session, LINEN_INVALID_INPUT,
                               "spline needs at least two points");
          }
          TColgp_Array1OfPnt points(1, pointCount);
          for (int index = 0; index < pointCount; ++index) {
            points.SetValue(index + 1,
                            lift(frame, cursor[1 + index * 2], cursor[2 + index * 2]));
          }
          GeomAPI_PointsToBSpline fit(points);
          edges->Append(BRepBuilderAPI_MakeEdge(fit.Curve()).Edge());
          break;
        }
        default:
          return linen::fail(session, LINEN_INVALID_INPUT, "unknown curve kind");
      }
      cursor += parameterCount;
    }

    if (edges->IsEmpty()) {
      return linen::fail(session, LINEN_INVALID_INPUT, "sketch produced no edges");
    }

    // Group edges into closed wires. A profile with a hole yields two
    // wires — outer and inner — and the face builder below treats the
    // extra ones as holes rather than as separate regions.
    Handle(TopTools_HSequenceOfShape) wires;
    ShapeAnalysis_FreeBounds::ConnectEdgesToWires(
      edges, Precision::Confusion(), Standard_False, wires);

    if (wires.IsNull() || wires->IsEmpty()) {
      return linen::fail(session, LINEN_OPERATION_FAILED, "edges do not form a closed wire");
    }

    const gp_Pln plane(frame);
    BRepBuilderAPI_MakeFace face(plane, TopoDS::Wire(wires->Value(1)));
    for (int index = 2; index <= wires->Length(); ++index) {
      face.Add(TopoDS::Wire(wires->Value(index)));
    }
    if (!face.IsDone()) {
      return linen::fail(session, LINEN_OPERATION_FAILED, "no closed region in sketch");
    }

    const linen_sketch_id sketch = session->nextSketch++;
    session->sketches[sketch] = face.Face();
    *out_sketch = sketch;
    return linen::ok();
  })
}
