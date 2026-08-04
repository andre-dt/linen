// =====================================================================
// compile/arena.rs — WHERE A LIST LIVES.
//
// Everything a call allocates comes out of an arena, and the whole arena
// goes when the call that owns it returns. No GC, no `free`, no
// ownership in the user's code.
//
// It works because there is no observable mutation: without it there is
// no cycle and no shared owner to track, so there is never a case where
// one thing has to die before another. Freeing everything at once is
// enough — which is the property that makes the whole model cheap.
//
// The consequence is the part that shapes the API above: NOTHING
// SURVIVES THE CALL THAT ALLOCATED IT. A result that has to outlive its
// call is copied out, explicitly.
//
// WHY A BUMP ALLOCATOR AND NOTHING ELSE
// -------------------------------------
// Allocation is `pointer += size`. There is no free list, no size
// classes, no coalescing, because nothing is ever freed individually —
// the arena is dropped whole. That is what makes building a list of ten
// thousand faces cost about what writing ten thousand structs costs.
//
// PUSH SHARES ITS PREFIX
// ----------------------
// `push` copies the old elements into new space and returns a list one
// longer. The old list is untouched and still valid, which is what makes
// the semantics immutable.
//
// Copying is the conservative version. When the old list is dead at that
// line — which it usually is, in `built = push(built, x)` — writing in
// place is something no observer can distinguish, and the compiler is
// free to do it. That optimisation is not here yet; the semantics do not
// change when it arrives, which is the point of doing it this way round.
// =====================================================================

use std::cell::RefCell;

/// A list, as the compiled code sees it: `{ i32 length, T* elements }`.
///
/// Repr C because this crosses into generated code, where the layout is
/// what the IR was told it is.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ListValue {
    pub length: i32,
    pub elements: *const u8,
}

/// A block of memory that is handed out and never individually returned.
struct Arena {
    blocks: Vec<Vec<u8>>,
    /// How much of the last block is used.
    used: usize,
}

/// How big a fresh block is. Large enough that a mesh does not spend its
/// time allocating blocks, small enough that a test allocating one list
/// does not reserve a megabyte.
const BLOCK: usize = 64 * 1024;

impl Arena {
    fn new() -> Arena {
        Arena {
            blocks: vec![vec![0u8; BLOCK]],
            used: 0,
        }
    }

    /// Space for `bytes`, aligned to 8.
    ///
    /// Eight because that is the widest alignment anything in this
    /// language needs — i64 and a pointer — and one alignment for
    /// everything is simpler than tracking it per type. i128 would need
    /// sixteen, and does not appear inside a list yet.
    fn allocate(&mut self, bytes: usize) -> *mut u8 {
        let aligned = (bytes + 7) & !7;

        // A request larger than a block gets a block of its own, rather
        // than failing or splitting: a list of ten thousand faces is one
        // allocation, and it should not be the case that works badly.
        //
        // Inserted BEFORE the current block rather than after it, so
        // `used` keeps referring to the block it was measuring. Pushing
        // the oversized one on the end would leave `used` pointing into
        // a block that is already full.
        if aligned > BLOCK {
            let mut block = vec![0u8; aligned];
            let pointer = block.as_mut_ptr();
            let last = self.blocks.len() - 1;
            self.blocks.insert(last, block);
            return pointer;
        }

        if self.used + aligned > BLOCK {
            self.blocks.push(vec![0u8; BLOCK]);
            self.used = 0;
        }
        let block = self.blocks.last_mut().expect("always one block");
        let pointer = unsafe { block.as_mut_ptr().add(self.used) };
        self.used += aligned;
        pointer
    }
}

thread_local! {
    // One arena per thread, reset between tests.
    //
    // Not per call yet: a per-call arena needs the compiler to emit the
    // scope, and the tests are what needs lists first. Reset between
    // tests is the same guarantee at a coarser grain — nothing survives
    // the test that allocated it.
    static ARENA: RefCell<Arena> = RefCell::new(Arena::new());
}

/// Throws away everything allocated so far. Called between tests.
pub fn reset_arena() {
    ARENA.with(|arena| *arena.borrow_mut() = Arena::new());
    FAULT.with(|fault| *fault.borrow_mut() = None);
}

fn allocate(bytes: usize) -> *mut u8 {
    ARENA.with(|arena| arena.borrow_mut().allocate(bytes))
}

// =====================================================================
// what the compiled code calls
// =====================================================================

/// `list()` — an empty list.
///
/// No allocation at all: a length of zero and a null pointer, which
/// nothing will read because nothing indexes an empty list.
#[no_mangle]
pub extern "C" fn linen_list_new() -> ListValue {
    ListValue {
        length: 0,
        elements: std::ptr::null(),
    }
}

/// `push(list:, value:)` — a new list, one longer.
///
/// `value` arrives by pointer rather than by value: the element type is
/// only known to the caller, and passing it indirectly means one
/// function works for every element type instead of one per type.
///
/// # Safety
/// `value` points to `element_size` readable bytes, and `list` is a list
/// this arena produced.
#[no_mangle]
pub unsafe extern "C" fn linen_list_push(
    list: ListValue,
    value: *const u8,
    element_size: i32,
) -> ListValue {
    let size = element_size.max(0) as usize;
    let length = list.length.max(0) as usize;

    // At least one byte, so the destination is never null. A
    // zero-length allocation would hand back whatever the bump pointer
    // happens to be, and `copy_nonoverlapping` rejects null even for a
    // count of zero.
    let space = allocate(((length + 1) * size).max(1));
    if length > 0 && size > 0 && !list.elements.is_null() {
        std::ptr::copy_nonoverlapping(list.elements, space, length * size);
    }
    if size > 0 && !value.is_null() {
        std::ptr::copy_nonoverlapping(value, space.add(length * size), size);
    }

    ListValue {
        length: (length + 1) as i32,
        elements: space,
    }
}

/// `length(list:)`.
#[no_mangle]
pub extern "C" fn linen_list_length(list: ListValue) -> i32 {
    list.length
}

// The out-of-range read that has happened since the last test started.
//
// A global for the same reason the drawn mesh is one: the compiled code
// calls a plain C function with no context pointer to carry a result
// through. One test runs at a time, so the window where it matters is
// one test wide.
thread_local! {
    static FAULT: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// The out-of-range read since `take_fault` was last called, if any.
pub fn take_fault() -> Option<String> {
    FAULT.with(|fault| fault.borrow_mut().take())
}

/// `at(list:, index:)` — a pointer to the element.
///
/// A pointer rather than the value, for the same reason `push` takes
/// one: the element type lives in the caller.
///
/// OUT OF RANGE IS A DEFECT, AND SAYS SO
/// -------------------------------------
/// This used to return null and leave the caller to decide. Nothing
/// decided: the generated code dereferenced it, and a bug two layers up
/// — a tessellator that produced fewer triangles than its caller
/// expected — arrived as a segfault with no test name attached.
///
/// Now the fault is recorded and a valid pointer is returned anyway, so
/// the test finishes and the runner reports which test read where. It
/// cannot unwind: this is called from compiled code across the C ABI,
/// where a Rust panic is undefined behaviour.
///
/// # Safety
/// `list` is a list this arena produced.
#[no_mangle]
pub unsafe extern "C" fn linen_list_at(
    list: ListValue,
    index: i32,
    element_size: i32,
) -> *const u8 {
    if index < 0 || index >= list.length || list.elements.is_null() {
        FAULT.with(|fault| {
            let mut fault = fault.borrow_mut();
            // The FIRST fault, not the last. Later ones are usually
            // consequences of it, and the first is the one to look at.
            if fault.is_none() {
                *fault = Some(format!(
                    "read element {index} of a list holding {}",
                    list.length.max(0)
                ));
            }
        });
        // Somewhere readable, so the caller's load lands in this
        // process's memory rather than at zero. Zeroed, so what it reads
        // is at least deterministic.
        return scratch(element_size.max(0) as usize);
    }
    list.elements
        .add(index as usize * element_size.max(0) as usize)
}

/// Zeroed bytes to hand back after a faulted read.
fn scratch(bytes: usize) -> *const u8 {
    allocate(bytes.max(1))
}
