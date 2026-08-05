// =====================================================================
// apps/web/widgets/field-parts.tsx — THE SHARED FIELD SKELETON.
//
// Every field in a command panel is the same shape, and that shape is
// declared here once:
//
//   ┌──────────────────────────────────────────────┐
//   │ [leading]  the control        [✕] [⋯] [⌄]    │   the BOX
//   └──────────────────────────────────────────────┘
//                     ↓ opens
//   ┌──────────────────────────────────────────────┐
//   │ [buttons]                                    │   panel HEADER
//   │ ────────────────────────────────────────────  │
//   │ whatever this field needs                    │   panel CONTENT
//   └──────────────────────────────────────────────┘
//
// A field decides what its control and its extra buttons ARE. It never
// decides how they are SIZED or SPACED — that is the whole point of these
// parts. Nine widgets each answering "how far apart are the trailing
// buttons" is nine chances to answer it differently, and they would.
//
// ORDER OF THE TRAILING BUTTONS IS A RULE, NOT A PREFERENCE
// ---------------------------------------------------------
//   clear (✕) → the field's own buttons → the panel chevron (⌄)
// Clear is leftmost and appears ONLY when there is a value to clear, so
// its position never shifts under the cursor. The chevron is always last,
// so "open this field's panel" is in the same place in every field.
//
// COMPOSITION, NOT CONFIGURATION
// ------------------------------
// A provider holds the state the parts share (open, value, invalid), so a
// button deep inside a field can read and write it without the field
// drilling props down to it. That matters because the control and the
// panel are SIBLINGS that never meet: both read the same value from
// context rather than the field wiring one to the other and getting two
// chances to disagree.
//
// Ark's Popover is used for the panel and does not leak past this file:
// the seam is here, so a field never imports Ark.
// =====================================================================

import {
  createContext, createSignal, useContext, Show,
  type Accessor, type JSX,
} from "solid-js"
import { Popover } from "@ark-ui/solid/popover"
import { Portal } from "solid-js/web"
import { LucideIcon } from "./lucide-icon"

// =====================================================================
// 1. THE SHARED STATE
// =====================================================================

export interface FieldContextValue {
  readonly open: Accessor<boolean>
  readonly setOpen: (open: boolean) => void
  readonly invalid: Accessor<boolean>
  /**
   * The field's value, held here rather than passed to each part.
   *
   * `unknown` because one context serves every field kind; each part
   * narrows to what it edits. A part reading the wrong shape is a wiring
   * mistake, and the field's own tests catch it immediately.
   */
  readonly value: Accessor<unknown>
  readonly commit: (value: unknown) => void
  /** Returns the field to no value. Separate from `commit(undefined)` so
   *  a field CAN tell the two apart; most do not, and for those this is
   *  exactly `commit(undefined)`. */
  readonly clear: () => void
}

const FieldContext = createContext<FieldContextValue>()

/** Throws outside a provider: a field part rendered outside a field is a
 *  wiring mistake, not a state to tolerate. */
export function useField(): FieldContextValue {
  const context = useContext(FieldContext)
  if (!context) throw new Error("useField must be used inside <FieldRoot>")
  return context
}

/** The same context, narrowed to the value type the caller knows this
 *  field holds — so no part has to write `as string` on the way out. */
export function useFieldValue<T>() {
  const field = useField()
  return {
    ...field,
    value: (): T | undefined => field.value() as T | undefined,
    commit: (next: T | undefined): void => field.commit(next),
  }
}

// =====================================================================
// 2. THE ROOT
// =====================================================================

export interface FieldRootProps {
  readonly invalid?: boolean
  readonly value?: unknown
  readonly onCommit?: (value: unknown) => void
  /** Defaults to `onCommit(undefined)` — what clearing means for every
   *  field that does not need to distinguish it. */
  readonly onClear?: () => void
  /** Controlled panel state, for a field that must close its own panel
   *  before something else opens. Uncontrolled otherwise. */
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  /** Makes the panel exactly as wide as the field, the way a combobox's
   *  list is. Opt in: an editor panel usually needs its own width. */
  readonly matchFieldWidth?: boolean
  readonly children: JSX.Element
}

export function FieldRoot(props: FieldRootProps) {
  const [uncontrolled, setUncontrolled] = createSignal(false)
  const open = (): boolean => props.open ?? uncontrolled()
  const setOpen = (next: boolean): void => {
    setUncontrolled(next)
    props.onOpenChange?.(next)
  }

  return (
    <FieldContext.Provider
      value={{
        open,
        setOpen,
        invalid: () => props.invalid === true,
        value: () => props.value,
        commit: (next) => props.onCommit?.(next),
        clear: () => (props.onClear ?? (() => props.onCommit?.(undefined)))(),
      }}
    >
      <Popover.Root
        lazyMount
        unmountOnExit
        open={open()}
        onOpenChange={(details) => setOpen(details.open)}
        // Stated once, here, so every field's panel lines up with its
        // field the same way. Left to Ark's default, each field would sit
        // slightly off from the one that opened it.
        positioning={{
          placement: "bottom-start",
          gutter: 4,
          sameWidth: props.matchFieldWidth,
        }}
      >
        {props.children}
      </Popover.Root>
    </FieldContext.Provider>
  )
}

// =====================================================================
// 3. THE BOX
// =====================================================================

export interface FieldBoxProps {
  /** Sits before the control, inside the box — a colour swatch, a plane
   *  glyph. Spaced by the same gap, so a leading chip is as far from the
   *  control as the control is from the buttons. */
  readonly leading?: JSX.Element
  readonly control: JSX.Element
  /** The trailing buttons. Order is the caller's, but the convention is
   *  clear → custom → chevron, and `FieldClear`/`FieldPanelTrigger`
   *  enforce their own halves of it. */
  readonly children?: JSX.Element
}

/**
 * The box. Anchors the panel to the WHOLE field rather than to the tiny
 * chevron, so the panel drops from the field the user is looking at.
 */
export function FieldBox(props: FieldBoxProps) {
  const field = useField()
  let box!: HTMLDivElement

  // No focus stealing on mousedown.
  //
  // These fields take no keyboard: the value arrives from a canvas
  // click, and there is nothing in the box to focus. Reaching for a
  // `.field-control` that is now a span moved focus nowhere and
  // preventDefault swallowed the press for no gain.

  return (
    <Popover.Anchor
      ref={box}
      class="field-box"
      // FILLED or not, which is the distinction that matters here.
      //
      // Not focused: a field in this panel is focused for reasons the
      // user did not choose — a step advances, a value is cleared and
      // the walk goes back — so highlighting the focused one draws the
      // eye somewhere it was not asked to look. Whether a field HAS an
      // answer is what a reader actually wants to see down a column.
      classList={{
        invalid: field.invalid(),
        filled: field.value() !== undefined && field.value() !== null,
      }}
    >
      {props.leading}
      {props.control}
      <div class="field-decorators">{props.children}</div>
    </Popover.Anchor>
  )
}

// =====================================================================
// 4. THE BUTTONS
// =====================================================================

export interface FieldIconButtonProps {
  /** The accessible name AND the tooltip. An icon-only button with
   *  neither is a glyph the user has to guess at. */
  readonly label: string
  readonly icon: string
  readonly active?: boolean
  readonly onClick: () => void
}

/**
 * The one small round icon button used inside a field and in a panel
 * header. One component so size, shape and hover stay identical wherever
 * it appears.
 */
export function FieldIconButton(props: FieldIconButtonProps) {
  return (
    <button
      type="button"
      class="field-icon-button"
      classList={{ active: props.active }}
      aria-label={props.label}
      title={props.label}
      // Keeps focus on the control: a mousedown here would otherwise blur
      // the input the user is still typing in.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => props.onClick()}
    >
      <LucideIcon name={props.icon} size={14} />
    </button>
  )
}

/**
 * Clears the field. ALWAYS the leftmost decorator, and present only when
 * there is something to clear — so it never appears under a cursor aimed
 * at the button beside it.
 */
export function FieldClear(props: { readonly label?: string }) {
  const field = useField()
  return (
    <Show when={field.value() !== undefined && field.value() !== null}>
      <FieldIconButton
        label={props.label ?? "Clear"}
        icon="x"
        onClick={() => field.clear()}
      />
    </Show>
  )
}

/**
 * Opens the field's panel. ALWAYS the last decorator, so "more settings"
 * is in the same place in every field.
 */
export function FieldPanelTrigger(props: { readonly label?: string }) {
  const field = useField()
  return (
    <Popover.Trigger
      class="field-icon-button field-chevron"
      classList={{ active: field.open() }}
      aria-label={props.label ?? "More settings"}
      title={props.label ?? "More settings"}
      onMouseDown={(event) => event.preventDefault()}
    >
      <LucideIcon name="chevron-down" size={14} />
    </Popover.Trigger>
  )
}

// =====================================================================
// 5. THE PANEL
// =====================================================================

export function FieldPanel(props: { readonly children: JSX.Element }) {
  return (
    <Portal>
      <Popover.Positioner>
        <Popover.Content class="field-panel">{props.children}</Popover.Content>
      </Popover.Positioner>
    </Portal>
  )
}

/**
 * The action row at the top of a panel, and the rule beneath it. Every
 * panel's header looks the same because it IS the same: icon-only
 * buttons, then a separator.
 *
 * Rendered as a fragment rather than a box so the panel's own column gap
 * spaces it — a header that brought its own margins would sit differently
 * from the content below it.
 */
export function FieldPanelHeader(props: { readonly children: JSX.Element }) {
  return (
    <>
      <div class="field-panel-actions">{props.children}</div>
      <div class="field-panel-rule" />
    </>
  )
}
