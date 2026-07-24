# =====================================================================
# packages/kernel-occt/Dockerfile
#
# Layer order is deliberate: the Conan restore lands BEFORE any source
# copy, so editing Rust never re-downloads OCCT.
# =====================================================================

FROM rust:1.83-bookworm AS occt-deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      cmake ninja-build python3-pip pkg-config \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages "conan>=2.4,<3"

WORKDIR /build
COPY conanfile.txt conan-profile ./

# The expensive layer, cached on the conanfile hash alone.
# --build=never fails loudly rather than silently falling back to a
# source build: a CI job that quietly compiles OCCT is a CI job that
# times out.
RUN conan profile detect --force \
 && conan install . \
      --output-folder=/opt/occt \
      --build=never \
      --profile:host=./conan-profile \
      --profile:build=./conan-profile

# ---------------------------------------------------------------------
FROM occt-deps AS build

WORKDIR /src
COPY Cargo.toml Cargo.lock build.rs ./
COPY native ./native

# Cargo dependency layer, cached separately from OCCT.
RUN mkdir -p src && echo "fn main() {}" > src/main.rs \
 && cargo build --release 2>/dev/null || true

COPY src ./src
ENV OCCT_ROOT=/opt/occt
RUN cargo build --release

# ---------------------------------------------------------------------
# Runtime carries the .node and nothing else: OCCT is inside it.
FROM node:22-bookworm-slim AS runtime
COPY --from=build /src/target/release/libkernel_occt.so /app/kernel-occt.node
