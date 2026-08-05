# The label font

`LiberationSans-Regular.ttf`, under the SIL Open Font License 1.1.

## Why a font is in the repository

So the same suite draws the same images on every machine.

Reading a font from the system makes the picture depend on which
fonts happen to be installed — a mosaic generated on one developer's
machine would differ from the same mosaic generated on another, and the
difference would be invisible until someone compared two PNGs and found
them not equal.

That is the same determinism the kernel itself is built for. A feature
tree regenerates into identical geometry; the pictures of it should
regenerate identically too.

## Why this one

Metric-compatible with Arial, so a label's width is predictable, and
401 KB — the smallest of the general-purpose faces available. The
licence permits redistribution, which a font in a repository needs.
