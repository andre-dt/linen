// =====================================================================
// syntax/load.rs — MANY FILES INTO ONE UNIT.
//
// `from './brep' use Vertex, Edge, Body` reads another file and brings
// those names into this one. By the time resolution or type checking
// runs, the imports are gone: what they named has been merged in as if
// it had been written here.
//
// WHY MERGE RATHER THAN KEEP MODULES APART
// ----------------------------------------
// A shape is a `Type::Shape(index)` into one table. If two files each
// interned `Vertex`, a `Vertex` built in one and read in the other would
// be two different types with the same name — and the error message
// would say `Vertex is not Vertex`, which is the worst kind.
//
// Merging makes that impossible by construction rather than by being
// careful. One table, one index per shape, everywhere.
//
// WHAT AN IMPORT DOES NOT DO
// --------------------------
// It does not make the whole imported file visible. Only the names
// listed arrive, so the top of a file still answers where each
// unqualified name in it came from. Anything the imported file itself
// imported stays private to it — imports are not transitive, and a name
// has to be asked for where it is used.
//
// The helpers an imported function calls DO come along, because they
// have to: `triangulate` cannot run without `is_ear`. They arrive
// unnameable — merged into the unit but absent from the importer's list
// of names — so calling one that was not asked for is still an error.
// =====================================================================

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::ast::{Item, Unit};
use crate::lex::lex;
use crate::parse::parse;
use crate::token::Span;

#[derive(Debug, PartialEq)]
pub struct LoadError {
    pub message: String,
    /// Where in `file` the problem is.
    pub span: Span,
    /// Which file, since a load spans several.
    pub file: PathBuf,
}

/// Reads a file's text. A parameter so tests can load from memory and
/// the compiler can load from disk, without the loader knowing which.
pub type ReadFile = dyn Fn(&Path) -> Result<String, String>;

/// Everything one file needs, merged: its own items plus those of every
/// file it imports, transitively.
///
/// The order is imports first, then the file's own items. Nothing
/// depends on it — resolution collects every signature before checking
/// any body — but a stable order keeps the generated code stable, and
/// determinism is the property the whole kernel rests on.
pub fn load(entry: &Path, root: &Path, read: &ReadFile) -> Result<Unit, LoadError> {
    let mut loaded = Loader {
        read,
        root: root.to_path_buf(),
        items: Vec::new(),
        done: HashMap::new(),
        stack: Vec::new(),
    };
    loaded.file(entry)?;
    Ok(Unit { items: loaded.items })
}

struct Loader<'a> {
    read: &'a ReadFile,
    /// Where `linen:` resolves to — the kernel's own source directory.
    root: PathBuf,
    /// The merged items, in load order.
    items: Vec<Item>,
    /// Files already merged, so a diamond loads once.
    ///
    /// `a` importing `b` and `c`, both importing `d`, must not merge
    /// `d` twice — the second copy would be a duplicate declaration of
    /// every name in it.
    done: HashMap<PathBuf, ()>,
    /// The chain currently being loaded, for reporting a cycle with the
    /// path that made it.
    stack: Vec<PathBuf>,
}

impl Loader<'_> {
    fn file(&mut self, path: &Path) -> Result<(), LoadError> {
        let path = normalise(path);

        if self.done.contains_key(&path) {
            return Ok(());
        }

        // A cycle is a real error, not something to break by loading a
        // partial file: `a` importing `b` importing `a` means neither
        // has a complete set of declarations, and which one wins would
        // depend on where the load started.
        if self.stack.contains(&path) {
            let mut chain: Vec<String> = self
                .stack
                .iter()
                .map(|each| each.display().to_string())
                .collect();
            chain.push(path.display().to_string());
            return Err(LoadError {
                message: format!("these files import each other: {}", chain.join(" -> ")),
                span: Span::new(0, 0),
                file: path,
            });
        }

        let source = (self.read)(&path).map_err(|message| LoadError {
            message,
            span: Span::new(0, 0),
            file: path.clone(),
        })?;

        let tokens = lex(&source).map_err(|error| LoadError {
            message: error.message,
            span: error.span,
            file: path.clone(),
        })?;
        let unit = parse(&tokens).map_err(|error| LoadError {
            message: error.message,
            span: error.span,
            file: path.clone(),
        })?;

        self.stack.push(path.clone());

        // Imports first, so what a file depends on is present before the
        // file itself.
        let directory = path.parent().unwrap_or(Path::new(".")).to_path_buf();
        for item in &unit.items {
            let Item::Import(import) = item else {
                continue;
            };
            let target = resolve_path(&directory, &import.path, &self.root);
            self.file(&target).map_err(|mut error| {
                // A file that does not exist is reported against the
                // line that asked for it, not against the missing file:
                // the import is what a reader can fix.
                if error.span == Span::new(0, 0) && error.file == normalise(&target) {
                    error.span = import.span;
                    error.file = path.clone();
                }
                error
            })?;

            // Every listed name has to be there. Without this an
            // import of a name that was renamed or removed would fail
            // far away, at the call site, saying the function does not
            // exist — with no hint that an import claimed it did.
            for wanted in &import.names {
                if !self.declares(&wanted.name) {
                    return Err(LoadError {
                        message: format!(
                            "`{}` does not declare `{}`",
                            import.path, wanted.name
                        ),
                        span: wanted.span,
                        file: path.clone(),
                    });
                }
            }
        }

        self.stack.pop();
        self.done.insert(path, ());

        for item in unit.items {
            if matches!(item, Item::Import(_)) {
                continue;
            }
            self.items.push(item);
        }
        Ok(())
    }

    /// Whether anything merged so far declares this name.
    fn declares(&self, name: &str) -> bool {
        self.items.iter().any(|item| match item {
            Item::Function(function) => function.name == name,
            Item::Shape(shape) => shape.name == name,
            Item::Test(_) | Item::Import(_) => false,
        })
    }
}

/// The prefix that names the standard library rather than a file
/// beside this one.
pub const STANDARD: &str = "linen:";

/// `./brep` next to `/x/y/part.lang` is `/x/y/brep.lang`.
///
/// The `.lang` is added here rather than written in the import: it is
/// the only extension a module can have, and repeating it at every
/// import is noise that never varies.
///
/// `linen:step` is different: it names the STANDARD LIBRARY, resolved
/// against the kernel's own source root rather than against the
/// importing file. Without it every test would reach the kernel through
/// `'./../src/brep'`, which is both ugly and wrong — it hard-codes how
/// deep the caller happens to sit.
fn resolve_path(directory: &Path, written: &str, root: &Path) -> PathBuf {
    let mut path = match written.strip_prefix(STANDARD) {
        Some(module) => root.join(module),
        None => directory.join(written),
    };
    path.set_extension("lang");
    path
}

/// Flattens `.` and `..` so that two spellings of one file compare
/// equal.
///
/// Textual, not `canonicalize`: the file may not exist yet, and a
/// missing file should be reported as missing rather than as a path
/// error. Symlinks are not followed, which means two names for one file
/// would load twice — noted rather than solved, since nothing in the
/// kernel is behind a symlink.
fn normalise(path: &Path) -> PathBuf {
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                // Only pop a real name. Leading `..` has nothing above
                // it to remove and has to stay.
                if parts.last().is_some_and(|last| last != "..") {
                    parts.pop();
                } else {
                    parts.push("..".into());
                }
            }
            other => parts.push(other.as_os_str().to_os_string()),
        }
    }
    parts.iter().collect()
}
