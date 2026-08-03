{
  "targets": [
    {
      "target_name": "linen-occt",

      # Only the boolean survives here. Sketch, extrude and tessellate were
      # removed: they are being rebuilt in the new kernel, and keeping a
      # second implementation of a feature that already moved is how the
      # two drift apart. `session` and `errors` stay because they are not
      # features — they are the registry the boolean stores bodies in and
      # the error path it reports through.
      "sources": [
        "session.cpp",
        "errors.cpp",
        "boolean.cpp"
      ],

      "include_dirs": [
        "..",
        ".",
        "<!(echo ${OCCT_ROOT}/include/opencascade)"
      ],

      "library_dirs": ["<!(echo ${OCCT_ROOT}/lib)"],

      # Link order matters. Static archives resolve left to right on the
      # GNU linker, so a library must appear BEFORE the ones it depends
      # on. OCCT layers as TK* -> TKernel, and getting this wrong yields
      # undefined-symbol errors that read as if the library were missing.
      #
      # Deliberately short: OCCT ships far more, and every extra module
      # inflates the artifact without ever being called.
      "libraries": [
        "-lTKBO",        # booleans
        "-lTKPrim",      # primitives and extrusion
        "-lTKOffset",    # shell, thicken, offset
        "-lTKFillet",    # fillet, chamfer
        "-lTKBool",      # boolean orchestration
        "-lTKShHealing", # healing after booleans
        "-lTKTopAlgo",   # topological algorithms
        "-lTKGeomAlgo",  # geometric algorithms
        "-lTKMesh",      # tessellation
        "-lTKBRep",      # the boundary representation
        "-lTKGeomBase",
        "-lTKG3d",
        "-lTKG2d",
        "-lTKMath",
        "-lTKernel",     # last: everything above depends on it
        "-lstdc++",
        "-lpthread",
        "-ldl",
        "-lm"
      ],

      "cflags_cc": [
        "-std=c++17",
        "-fexceptions",
        # OCCT headers are noisy; our own code stays warning-clean.
        "-Wno-unused-parameter",
        "-Wno-deprecated-declarations"
      ],

      # OCCT signals failure by throwing. Exceptions must survive to
      # reach LINEN_GUARD, the only thing between a modelling error and a
      # dead process that takes every session with it.
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"]
    }
  ]
}
