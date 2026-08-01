// =====================================================================
// apps/web/toast.tsx — TRANSIENT MESSAGES, app-wide.
//
// One provider at the root, one hook everywhere else. A toast is how the
// app says something that is worth seeing but not worth a dialog: a save
// failed, a feature is not built yet, a background job finished.
//
// WHY A PROVIDER RATHER THAN A SIGNAL PER SCREEN
// ----------------------------------------------
// Two screens had already grown their own `error()` signal rendered into
// a fixed slot. That works until two of them are live at once, or until
// something below a screen — a widget, deep in a panel — needs to speak.
// A widget cannot reach a screen's local signal, and passing an `onError`
// prop down through every layer to let it try is the pattern this
// replaces.
//
// LIFETIME IS A PROPERTY OF THE MESSAGE
// -------------------------------------
// Transient toasts vanish on their own after a few seconds; persistent
// ones stay until acknowledged. Which one a message is depends on whether
// missing it costs anything, so it travels WITH the message rather than
// being a setting on the provider.
//
// Every toast dismisses on click, persistent or not. A toast carrying an
// `action` runs it first, then dismisses — so "Retry" is one click, not a
// click to act and another to clear.
// =====================================================================

import {
  createContext, createSignal, useContext, onCleanup, For, Show,
  type JSX,
} from "solid-js"
import { LucideIcon } from "./widgets/lucide-icon"

// =====================================================================
// 1. WHAT A TOAST IS
// =====================================================================

/** How loud the message is. Drives colour and icon, nothing else — the
 *  behaviour of a toast is set by `persistent`, not by its level. */
export type ToastLevel = "info" | "success" | "warning" | "error"

export interface ToastOptions {
  readonly level?: ToastLevel
  /** Stays until dismissed instead of expiring. For anything the user
   *  must not miss, and for anything carrying an `action`. */
  readonly persistent?: boolean
  /** An offer attached to the message ("Retry", "Undo"). Clicking the
   *  toast runs it and then dismisses. */
  readonly action?: ToastAction
  /** Overrides the default lifetime. Ignored when persistent. */
  readonly durationMilliseconds?: number
}

export interface ToastAction {
  readonly label: string
  readonly run: () => void
}

export interface Toast {
  readonly id: number
  readonly text: string
  readonly level: ToastLevel
  readonly persistent: boolean
  readonly action: ToastAction | null
}

/** Long enough to read a sentence, short enough not to linger over the
 *  model. Anything that needs longer should be persistent instead — a
 *  bigger number is a worse answer to "the user might miss it". */
const DEFAULT_DURATION_MILLISECONDS = 5000

// =====================================================================
// 2. THE CONTEXT
// =====================================================================

export interface ToastApi {
  /** Raises a toast and returns its id, so a caller that owns a
   *  long-running thing can dismiss its own message when the thing ends. */
  readonly show: (text: string, options?: ToastOptions) => number
  readonly dismiss: (id: number) => void
  /** Every live toast, newest last. Exposed for tests and for a future
   *  notification centre; screens should not need it. */
  readonly toasts: () => readonly Toast[]
}

const ToastContext = createContext<ToastApi>()

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  // Named loudly rather than returning a no-op: a toast that silently
  // goes nowhere is worse than a crash at mount, because the message it
  // was carrying is lost with no trace.
  if (!api) throw new Error("useToast must be used inside <ToastProvider>")
  return api
}

// =====================================================================
// 3. THE PROVIDER
// =====================================================================

export function ToastProvider(props: { children: JSX.Element }) {
  const [toasts, setToasts] = createSignal<readonly Toast[]>([])
  let nextId = 1
  // Kept so unmounting the provider does not leave timers firing into a
  // disposed graph.
  const timers = new Map<number, ReturnType<typeof setTimeout>>()

  const dismiss = (id: number): void => {
    const timer = timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(id)
    }
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }

  const show = (text: string, options: ToastOptions = {}): number => {
    const id = nextId++
    // An action implies persistence: an offer that expires while being
    // read is a worse outcome than one more click to clear.
    const persistent = options.persistent ?? options.action !== undefined
    setToasts((current) => [
      ...current,
      {
        id,
        text,
        level: options.level ?? "info",
        persistent,
        action: options.action ?? null,
      },
    ])
    if (!persistent) {
      const duration = options.durationMilliseconds ?? DEFAULT_DURATION_MILLISECONDS
      timers.set(id, setTimeout(() => dismiss(id), duration))
    }
    return id
  }

  onCleanup(() => {
    timers.forEach((timer) => clearTimeout(timer))
    timers.clear()
  })

  return (
    <ToastContext.Provider value={{ show, dismiss, toasts }}>
      {props.children}
      <ToastStack toasts={toasts()} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

// =====================================================================
// 4. THE STACK
// =====================================================================
// Bottom right, newest at the bottom — so a burst of messages pushes
// older ones UP and away from the corner the eye returns to, and the
// newest is always in the same place.

// Lucide's CURRENT names. The older aliases (check-circle,
// alert-triangle, alert-circle) no longer resolve, and LucideIcon renders
// nothing for a name it cannot load — so a wrong name here is a silently
// missing icon rather than an error.
const ICONS: Record<ToastLevel, string> = {
  info: "info",
  success: "circle-check",
  warning: "triangle-alert",
  error: "circle-alert",
}

function ToastStack(props: {
  readonly toasts: readonly Toast[]
  readonly onDismiss: (id: number) => void
}) {
  return (
    // Absent entirely when empty, rather than an invisible fixed layer
    // sitting over the corner of the canvas swallowing clicks.
    <Show when={props.toasts.length > 0}>
      <div class="toast-stack">
        <For each={props.toasts}>
          {(toast) => (
            <button
              class="toast"
              data-level={toast.level}
              data-persistent={toast.persistent}
              // The whole toast is the dismiss target — a separate close
              // affordance would be a smaller target for the same result.
              // An action runs FIRST, then the toast clears.
              onClick={() => {
                toast.action?.run()
                props.onDismiss(toast.id)
              }}
            >
              {/* Wrapped rather than styled directly: the icon module
                  loads async, and until it lands LucideIcon renders a
                  placeholder span instead. The wrapper keeps the row's
                  geometry identical either way, so the text does not
                  shift when the glyph arrives. */}
              <span class="toast-icon">
                <LucideIcon name={ICONS[toast.level]} size={15} />
              </span>
              <span class="toast-text">{toast.text}</span>
              <Show when={toast.action}>
                {(action) => <span class="toast-action">{action().label}</span>}
              </Show>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
