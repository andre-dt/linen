// =====================================================================
// packages/kernel-occt/native/src/extrude.cpp
//
// The one operation the MVP has to get exactly right, because face
// ordering here is what every stored selector depends on.
// =====================================================================

#include "linen.h"
#include "session.hpp"

#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepOffsetAPI_MakeDraft.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <BRep_Tool.hxx>
#include <Geom_Surface.hxx>
#include <Geom_Plane.hxx>
#include <GProp_GProps.hxx>
#include <BRepGProp.hxx>
#include <gp_Vec.hxx>
#include <gp_Dir.hxx>

#include <algorithm>
#include <vector>

namespace {

// =====================================================================
// DETERMINISTIC FACE ORDERING
// =====================================================================
// This is the heart of topological identity, and the thing CadQuery
// never solved. There, equality is OCCT pointer identity: every
// boolean regenerates the underlying shapes, so no stored reference
// survives an operation and a selector like `>Z[-2]` can silently pick
// a different face after a parameter changes. The resulting solid is
// valid and wrong, with no error anywhere.
//
// Our answer: never expose kernel ordering. Classify each face by its
// semantic ROLE relative to the extrusion direction, then sort within
// a role by a geometric key that does not depend on how OCCT happened
// to walk the shape.
//
// The sort key must be stable under parameter change. Centroid
// projected onto two axes perpendicular to the extrusion works because
// moving the profile moves every side face together, preserving their
// relative order.

struct RoleFaces {
  std::vector<TopoDS_Face> start;
  std::vector<TopoDS_Face> end;
  std::vector<TopoDS_Face> side;
};

gp_Pnt faceCentroid(const TopoDS_Face& face) {
  GProp_GProps properties;
  BRepGProp::SurfaceProperties(face, properties);
  return properties.CentreOfMass();
}

// Is this face perpendicular to the sweep, and at which end?
enum class Cap { None, Start, End };

Cap classifyCap(const TopoDS_Face& face, const gp_Dir& sweep, double startOffset, double endOffset) {
  Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
  Handle(Geom_Plane) plane = Handle(Geom_Plane)::DownCast(surface);
  if (plane.IsNull()) return Cap::None; // curved: necessarily a side

  const gp_Dir normal = plane->Axis().Direction();
  // Within a degree of parallel to the sweep direction.
  if (std::abs(normal.Dot(sweep)) < 0.9998) return Cap::None;

  const double along = faceCentroid(face).XYZ().Dot(sweep.XYZ());
  return std::abs(along - startOffset) < std::abs(along - endOffset) ? Cap::Start : Cap::End;
}

RoleFaces classifyFaces(const TopoDS_Shape& solid, const gp_Dir& sweep,
                        double startOffset, double endOffset) {
  RoleFaces roles;
  for (TopExp_Explorer explorer(solid, TopAbs_FACE); explorer.More(); explorer.Next()) {
    const TopoDS_Face face = TopoDS::Face(explorer.Current());
    switch (classifyCap(face, sweep, startOffset, endOffset)) {
      case Cap::Start: roles.start.push_back(face); break;
      case Cap::End:   roles.end.push_back(face);   break;
      case Cap::None:  roles.side.push_back(face);  break;
    }
  }

  // Two axes perpendicular to the sweep give every face a position
  // that varies smoothly with the parameters, so the order holds.
  gp_Dir first = sweep.IsParallel(gp_Dir(0, 0, 1), 0.01)
                   ? gp_Dir(1, 0, 0)
                   : gp_Dir(gp_Vec(0, 0, 1).Crossed(gp_Vec(sweep)));
  gp_Dir second(gp_Vec(sweep).Crossed(gp_Vec(first)));

  const auto byPosition = [&](const TopoDS_Face& left, const TopoDS_Face& right) {
    const gp_Pnt a = faceCentroid(left);
    const gp_Pnt b = faceCentroid(right);
    // Angular order around the sweep axis: rotationally coherent, so a
    // radius change does not shuffle the sides.
    const double angleA = std::atan2(a.XYZ().Dot(second.XYZ()), a.XYZ().Dot(first.XYZ()));
    const double angleB = std::atan2(b.XYZ().Dot(second.XYZ()), b.XYZ().Dot(first.XYZ()));
    if (std::abs(angleA - angleB) > 1e-9) return angleA < angleB;
    // Tie-break along the sweep so coincident angles stay ordered.
    return a.XYZ().Dot(sweep.XYZ()) < b.XYZ().Dot(sweep.XYZ());
  };

  std::sort(roles.side.begin(), roles.side.end(), byPosition);
  std::sort(roles.start.begin(), roles.start.end(), byPosition);
  std::sort(roles.end.begin(), roles.end.end(), byPosition);
  return roles;
}

} // namespace

extern "C" linen_error linen_extrude(
    linen_session handle,
    const linen_extrude_input* input,
    linen_extrude_output* out_result) {
  auto* session = static_cast<linen::Session*>(handle);

  LINEN_GUARD(session, {
    // Validate before touching OCCT. An unknown sketch id reaching
    // BRepPrimAPI is an assertion failure, not an exception.
    const auto profile = session->sketches.find(input->profile);
    if (profile == session->sketches.end()) {
      return linen::fail(session, LINEN_INVALID_INPUT, "unknown sketch");
    }
    if (input->forward <= 0 && input->backward <= 0) {
      return linen::fail(session, LINEN_INVALID_INPUT, "extrusion has zero length");
    }

    gp_Vec direction(input->direction[0], input->direction[1], input->direction[2]);
    if (direction.Magnitude() < 1e-12) {
      return linen::fail(session, LINEN_INVALID_INPUT, "degenerate direction");
    }
    direction.Normalize();

    const gp_Vec sweep = direction * (input->forward + input->backward);
    TopoDS_Shape base = profile->second;
    if (input->backward > 0) {
      // Two-sided: shift the profile back, then sweep the total.
      gp_Trsf shift;
      shift.SetTranslation(direction * -input->backward);
      base = BRepBuilderAPI_Transform(base, shift, true).Shape();
    }

    BRepPrimAPI_MakePrism prism(base, sweep);
    prism.Build();
    if (!prism.IsDone()) {
      return linen::fail(session, LINEN_OPERATION_FAILED, "prism construction failed");
    }
    const TopoDS_Shape solid = prism.Shape();

    // Register and hand back integers. No OCCT type crosses out.
    const linen_body_id body = session->nextBody++;
    session->bodies[body] = solid;

    const gp_Dir sweepDirection(direction);
    const RoleFaces roles = classifyFaces(
      solid, sweepDirection, -input->backward, input->forward);

    auto registerFaces = [&](const std::vector<TopoDS_Face>& faces) {
      auto* ids = new linen_face_id[faces.size()];
      for (size_t index = 0; index < faces.size(); ++index) {
        const linen_face_id id = session->nextFace++;
        session->faces[id] = faces[index];
        session->faceOwners[id] = body;
        ids[index] = id;
      }
      return ids;
    };

    out_result->body = body;
    out_result->start_faces = registerFaces(roles.start);
    out_result->start_count = roles.start.size();
    out_result->end_faces = registerFaces(roles.end);
    out_result->end_count = roles.end.size();
    out_result->side_faces = registerFaces(roles.side);
    out_result->side_count = roles.side.size();

    return linen::ok();
  })
}
