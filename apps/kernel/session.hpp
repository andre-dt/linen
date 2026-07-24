// =====================================================================
// apps/kernel/session.hpp
//
// Shared internals. Not part of the C boundary.
// =====================================================================

#ifndef LINEN_SESSION_HPP
#define LINEN_SESSION_HPP

#include "linen.h"

#include <Standard_Failure.hxx>
#include <string>
#include <vector>

namespace linen {

struct Session;

linen_error ok();
linen_error fail(Session* session, linen_status status, const std::string& message);
std::string describe(const Standard_Failure& failure);

} // namespace linen

// Wraps an entry point so no OCCT exception can reach N-API. Every
// extern "C" function that touches OCCT must use this.
#define LINEN_GUARD(session, body)                                            \
  try {                                                                       \
    body                                                                      \
  } catch (const Standard_Failure& failure) {                                 \
    return linen::fail((session), LINEN_OPERATION_FAILED,                     \
                       linen::describe(failure));                             \
  } catch (const std::exception& error) {                                     \
    return linen::fail((session), LINEN_INTERNAL, error.what());              \
  } catch (...) {                                                             \
    return linen::fail((session), LINEN_INTERNAL, "unknown native failure");  \
  }

#endif // LINEN_SESSION_HPP
