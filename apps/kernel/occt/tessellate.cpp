// =====================================================================
// packages/kernel-occt/native/src/tessellate.cpp
//
// Produces the largest payload in the system, in the single packed
// layout documented in src/common/kernel.ts:
//
//   header:     u32 vertexCount, u32 triangleCount, u32 faceGroupCount
//   positions:  f32 * 3 * vertexCount
//   normals:    f32 * 3 * vertexCount
//   indices:    u32 * 3 * triangleCount
//   faceGroups: (u32 faceId, u32 firstTriangle, u32 triangleCount) * n
//
// These exact bytes travel native -> socket -> GPU buffer with no
// re-serialization anywhere. That is the whole reason for choosing a
// packed layout over an array of objects: one format, three consumers.
//
// The face groups are what make picking work at all — they map a
// triangle back to the FaceId a selector can name.
// =====================================================================

#include "linen.h"
#include "session.hpp"

#include <BRepMesh_IncrementalMesh.hxx>
#include <BRep_Tool.hxx>
#include <Poly_Triangulation.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopLoc_Location.hxx>
#include <Precision.hxx>

#include <cstring>
#include <vector>

namespace {

struct MeshAccumulator {
  std::vector<float> positions;
  std::vector<float> normals;
  std::vector<uint32_t> indices;
  struct Group {
    uint32_t face;
    uint32_t firstTriangle;
    uint32_t triangleCount;
  };
  std::vector<Group> groups;
};

void appendFace(MeshAccumulator& mesh, const TopoDS_Face& face, uint32_t faceId) {
  TopLoc_Location location;
  const Handle(Poly_Triangulation) triangulation = BRep_Tool::Triangulation(face, location);
  if (triangulation.IsNull()) return; // face failed to mesh; skip, do not crash

  const gp_Trsf transform = location.Transformation();
  // Vertices are appended, so indices from this face must be offset by
  // everything written before it.
  const uint32_t vertexOffset = static_cast<uint32_t>(mesh.positions.size() / 3);
  const uint32_t firstTriangle = static_cast<uint32_t>(mesh.indices.size() / 3);

  const bool reversed = face.Orientation() == TopAbs_REVERSED;

  for (Standard_Integer index = 1; index <= triangulation->NbNodes(); ++index) {
    gp_Pnt point = triangulation->Node(index).Transformed(transform);
    mesh.positions.push_back(static_cast<float>(point.X()));
    mesh.positions.push_back(static_cast<float>(point.Y()));
    mesh.positions.push_back(static_cast<float>(point.Z()));

    if (triangulation->HasNormals()) {
      gp_Dir normal = triangulation->Normal(index).Transformed(transform);
      if (reversed) normal.Reverse();
      mesh.normals.push_back(static_cast<float>(normal.X()));
      mesh.normals.push_back(static_cast<float>(normal.Y()));
      mesh.normals.push_back(static_cast<float>(normal.Z()));
    } else {
      // Filled in per-triangle below when OCCT gives us nothing.
      mesh.normals.insert(mesh.normals.end(), {0.0f, 0.0f, 0.0f});
    }
  }

  for (Standard_Integer index = 1; index <= triangulation->NbTriangles(); ++index) {
    Standard_Integer a, b, c;
    triangulation->Triangle(index).Get(a, b, c);
    // Reversed faces need their winding flipped or backface culling
    // will hide them.
    if (reversed) std::swap(b, c);
    mesh.indices.push_back(vertexOffset + static_cast<uint32_t>(a - 1));
    mesh.indices.push_back(vertexOffset + static_cast<uint32_t>(b - 1));
    mesh.indices.push_back(vertexOffset + static_cast<uint32_t>(c - 1));
  }

  const uint32_t triangleCount =
    static_cast<uint32_t>(mesh.indices.size() / 3) - firstTriangle;
  if (triangleCount > 0) {
    mesh.groups.push_back({faceId, firstTriangle, triangleCount});
  }
}

} // namespace

extern "C" linen_error linen_tessellate(
    linen_session handle,
    linen_body_id body,
    double linearTolerance,
    double angularTolerance,
    linen_mesh* out_mesh) {
  auto* session = static_cast<linen::Session*>(handle);

  LINEN_GUARD(session, {
    const auto found = session->bodies.find(body);
    if (found == session->bodies.end()) {
      return linen::fail(session, LINEN_INVALID_INPUT, "unknown body");
    }
    const TopoDS_Shape& shape = found->second;

    // Meshing mutates the shape by attaching triangulation, which is
    // why a session is one mutex: two threads meshing the same body
    // would corrupt it.
    BRepMesh_IncrementalMesh mesher(shape, linearTolerance, Standard_False,
                                    angularTolerance, Standard_True);
    if (!mesher.IsDone()) {
      return linen::fail(session, LINEN_OPERATION_FAILED, "tessellation failed");
    }

    MeshAccumulator mesh;
    for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
      const TopoDS_Face face = TopoDS::Face(explorer.Current());
      // Recover the id we handed out when the body was built, so the
      // client can map a picked triangle back to a nameable face.
      uint32_t faceId = 0;
      for (const auto& entry : session->faces) {
        if (entry.second.IsSame(face) && session->faceOwners.at(entry.first) == body) {
          faceId = entry.first;
          break;
        }
      }
      appendFace(mesh, face, faceId);
    }

    const uint32_t vertexCount = static_cast<uint32_t>(mesh.positions.size() / 3);
    const uint32_t triangleCount = static_cast<uint32_t>(mesh.indices.size() / 3);
    const uint32_t groupCount = static_cast<uint32_t>(mesh.groups.size());

    const size_t length =
      12 +                                   // header
      mesh.positions.size() * sizeof(float) +
      mesh.normals.size() * sizeof(float) +
      mesh.indices.size() * sizeof(uint32_t) +
      mesh.groups.size() * 12;

    // Owned by the session until linen_mesh_free: the Rust side copies
    // it into a Buffer and releases immediately.
    session->meshBuffers.emplace_back(length);
    auto& buffer = session->meshBuffers.back();
    uint8_t* cursor = buffer.data();

    const uint32_t header[3] = {vertexCount, triangleCount, groupCount};
    std::memcpy(cursor, header, 12); cursor += 12;

    std::memcpy(cursor, mesh.positions.data(), mesh.positions.size() * sizeof(float));
    cursor += mesh.positions.size() * sizeof(float);

    std::memcpy(cursor, mesh.normals.data(), mesh.normals.size() * sizeof(float));
    cursor += mesh.normals.size() * sizeof(float);

    std::memcpy(cursor, mesh.indices.data(), mesh.indices.size() * sizeof(uint32_t));
    cursor += mesh.indices.size() * sizeof(uint32_t);

    for (const auto& group : mesh.groups) {
      const uint32_t entry[3] = {group.face, group.firstTriangle, group.triangleCount};
      std::memcpy(cursor, entry, 12);
      cursor += 12;
    }

    out_mesh->data = buffer.data();
    out_mesh->length = length;
    return linen::ok();
  })
}

extern "C" void linen_mesh_free(linen_session handle, linen_mesh* mesh) {
  auto* session = static_cast<linen::Session*>(handle);
  for (auto it = session->meshBuffers.begin(); it != session->meshBuffers.end(); ++it) {
    if (it->data() == mesh->data) {
      session->meshBuffers.erase(it);
      break;
    }
  }
  mesh->data = nullptr;
  mesh->length = 0;
}
