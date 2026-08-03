# tests/

The compiler's suite, written in the language itself.

One flat directory. What a file expects is written IN the file, not
encoded in which folder it sits in:

    no `#~`   must compile, and every assert holds
    `#~ ...`  must NOT compile, and must fail with that message

A `#~` line goes just above the mistake it predicts:

    test "an assert that is never closed"
      #~ expected `)` to close the assert
      assert(1 + 1

Flat because the expectation belongs to the file. A pass/ and fail/ split
would say the same thing twice — once in the path, once in the contents —
and two places to say something is one place to get it wrong.

Checking only that compilation failed would let a wrong-but-failing
message through. For a compiler error the message IS the product, so a bad
one is a bug and the suite treats it as one.

By convention a rejection case is named `reject-<what-is-wrong>.lang`, so
the directory listing reads as a catalogue of what the compiler refuses.
The name is convention only — the `#~` is what actually classifies.

Run it two ways, and both walk this directory:

    linen test      the user-facing command
    cargo test      the compiler's own build, which this must not break

`PENDING.md` lists errors the compiler does NOT catch yet. They are notes
rather than failing tests: a suite that is red from day one teaches
everyone to ignore red.
