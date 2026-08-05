// =====================================================================
// cli/scene.rs — A TEST THAT CAN BE SEEN.
//
// A `test draws "..."` builds a solid and hands it over with `solid(…)`.
// Each such test becomes one tile; the tiles of one .lang file become
// one .png beside it.
//
//   kernel-box.lang  ->  kernel-box.png
//     "a box of 200 microns"      a tile
//     "a box at full range"       a tile
//
// ONE PICTURE PER FILE, ONE TILE PER TEST
// ---------------------------------------
// The earlier version drew one picture per FILE, from a pair of
// specially-named functions. That picture belonged to no test: a file
// asserting six different things about a box showed one box, and which
// of the six it was nobody could say.
//
// Now the label under a tile is the test's own description, so the
// picture and the sentence describing it cannot disagree.
// =====================================================================

use std::path::Path;

use compile::run::Ran;

use draw::gallery::{write_gallery, Tile, TILE_HEIGHT, TILE_WIDTH};
use draw::render::{render, Mesh, MeshKind, Point3};


/// Renders every drawing test of one file into a mosaic beside it.
///
/// Returns how many tiles it drew.
pub fn render_file(ran: &[Ran], source: &Path) -> Result<usize, String> {
    let mut tiles = Vec::new();

    for test in ran {
        let Some(mesh) = &test.mesh else {
            continue;
        };
        let mesh = Mesh {
            points: mesh
                .points
                .chunks_exact(3)
                .map(|p| Point3 {
                    x: p[0] as i64,
                    y: p[1] as i64,
                    z: p[2] as i64,
                })
                .collect(),
            triangles: mesh.triangles.iter().map(|index| *index as usize).collect(),
            kind: match mesh.kind {
                compile::run::MeshKind::Wire => MeshKind::Wire,
                compile::run::MeshKind::Solid => MeshKind::Solid,
            },
        };

        // A triangle naming a point that is not there would panic in the
        // renderer. Reported here, where the message can say which test.
        if mesh.triangles.iter().any(|index| *index >= mesh.points.len()) {
            return Err(format!(
                "`{}` has a triangle indexing a point that is not there",
                test.name
            ));
        }

        tiles.push(Tile {
            label: test.name.clone(),
            image: render(&mesh, TILE_WIDTH, TILE_HEIGHT),
        });
    }

    if tiles.is_empty() {
        return Ok(0);
    }
    write_gallery(&tiles, &source.with_extension("png"))
}
