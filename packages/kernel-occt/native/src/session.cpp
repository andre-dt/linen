// =====================================================================
// packages/kernel-occt/native/src/session.cpp
//
// The shape registry. OCCT objects live here and nowhere else; the
// TypeScript side only ever holds integers.
// =====================================================================

#include "linen.h"
#include "session.hpp"

#include <Standard_Failure.hxx>
#include <TopoDS_Shape.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>

#include <string>
#include <unordered_map>
#include <mutex>

namespace linen {

// One mutex per session. OCCT is not thread-safe across operations on
// the same shape, so calls within a session serialize while separate
// sessions run in parallel on the libuv pool.
struct Session {
  std::mutex mutex;
  std::unordered_map<linen_body_id, TopoDS_Shape> bodies;
  std::unordered_map<linen_sketch_id, TopoDS_Shape> sketches;
  // Face handles are per-body: a face id means nothing without knowing
  // which body it came from, and validating that is what keeps a
  // mis-selected fillet from crashing us.
  std::unordered_map<linen_face_id, linen_body_id> faceOwners;
  std::unordered_map<linen_face_id, TopoDS_Shape> faces;

  linen_body_id nextBody = 1;
  linen_sketch_id nextSketch = 1;
  linen_face_id nextFace = 1;

  // Owns the message pointer handed back in linen_error. Valid until
  // the next call on this session.
  std::string lastError;

  std::vector<std::vector<uint8_t>> meshBuffers;
};

linen_error ok() {
  return linen_error{LINEN_OK, nullptr};
}

linen_error fail(Session* session, linen_status status, const std::string& message) {
  session->lastError = message;
  return linen_error{status, session->lastError.c_str()};
}

} // namespace linen

using linen::Session;

extern "C" {

linen_session linen_session_open(void) {
  return new Session();
}

void linen_session_close(linen_session handle) {
  // Explicit teardown. Nothing here waits on a garbage collector:
  // OCCT holds a great deal of memory and V8 cannot see any of it.
  delete static_cast<Session*>(handle);
}

void linen_session_release(linen_session handle, const linen_body_id* bodies, size_t count) {
  auto* session = static_cast<Session*>(handle);
  std::lock_guard<std::mutex> guard(session->mutex);
  for (size_t index = 0; index < count; ++index) {
    const linen_body_id body = bodies[index];
    session->bodies.erase(body);
    // Drop the faces that belonged to it, or the maps grow forever.
    for (auto it = session->faceOwners.begin(); it != session->faceOwners.end();) {
      if (it->second == body) {
        session->faces.erase(it->first);
        it = session->faceOwners.erase(it);
      } else {
        ++it;
      }
    }
  }
}

size_t linen_session_live_count(linen_session handle) {
  auto* session = static_cast<Session*>(handle);
  std::lock_guard<std::mutex> guard(session->mutex);
  return session->bodies.size();
}

int linen_entity_belongs_to(linen_session handle, linen_body_id body, linen_face_id face) {
  auto* session = static_cast<Session*>(handle);
  std::lock_guard<std::mutex> guard(session->mutex);
  const auto found = session->faceOwners.find(face);
  return found != session->faceOwners.end() && found->second == body ? 1 : 0;
}

} // extern "C"
