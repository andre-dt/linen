// =====================================================================
// draw — PIXELS.
//
// A mesh in, an image out. Two things live here:
//
//   render    triangles and lines onto a pixel buffer
//   gallery   several rendered tiles into one mosaic
//
// Neither knows what a kernel is. That is the point of the split: a
// question about where a line lands is a question about pixels, and
// answering it should not require compiling anything.
// =====================================================================

pub mod gallery;
pub mod render;
pub mod text;
