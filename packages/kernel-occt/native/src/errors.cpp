// =====================================================================
// packages/kernel-occt/native/src/errors.cpp
//
// OCCT signals failure by throwing Standard_Failure, and occasionally
// by crashing outright. A C++ exception reaching N-API tears down the
// process, so every entry point converts here instead.
//
// The macro exists so no entry point can forget: an uncaught throw is
// not a bug that shows up as a stack trace, it is a dead server.
// =====================================================================

#include "linen.h"
#include "session.hpp"

#include <Standard_Failure.hxx>
#include <string>

namespace linen {

std::string describe(const Standard_Failure& failure) {
  std::string message = failure.DynamicType()->Name();
  if (failure.GetMessageString() != nullptr && failure.GetMessageString()[0] != '\0') {
    message += ": ";
    message += failure.GetMessageString();
  }
  return message;
}

} // namespace linen
