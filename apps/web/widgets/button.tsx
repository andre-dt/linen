// =====================================================================
// apps/web/widgets/button.tsx — THE base button, used everywhere.
//
// Every button in the HUD — toolbar tools, panel actions, the view cube's
// trigger and its flower cells — is this one component. It owns the shared
// look: a squircle (iOS-style rounded corners), consistent sizing, the hover
// and active feedback. Callers pick a `variant` and, for square icon
// buttons, a `size`; they never restyle the base.
//
// One component means one place to change the button language: adjust the
// squircle radius or the hover here and all of them move together.
// =====================================================================

import { splitProps, type JSX } from "solid-js"
import { Tooltip } from "@ark-ui/solid/tooltip"

export type ButtonVariant =
  // A square icon button on the navy HUD panel material (view cube, tools).
  | "hud-icon"
  // A text button on the HUD (New, Sign out, …).
  | "hud"
  // A subtle/ghost text button (transparent until hover).
  | "hud-subtle"

/** The one icon-button edge length, in px. EVERY square icon button on the
 *  HUD is this size. It lives here because it is a visual characteristic:
 *  wrappers choose behavior, never look.
 *
 *  It is also the size a collapsed HUD panel presents, which is why the
 *  panel header's own minimize button is sized to approach it — a control
 *  and the control that undoes it should not be wildly different targets. */
export const ICON_SIZE = 40

export interface BaseButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  /** Square edge length for icon buttons, in px. Defaults to ICON_SIZE. */
  size?: number
}

export function BaseButton(props: BaseButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "size", "class", "style", "children"])

  const variant = (): ButtonVariant => local.variant ?? "hud"
  const isIcon = (): boolean => variant() === "hud-icon"

  return (
    <button
      {...rest}
      class={`ui-button ui-button-${variant()} ${local.class ?? ""}`}
      style={
        isIcon()
          ? {
              width: `${local.size ?? ICON_SIZE}px`,
              height: `${local.size ?? ICON_SIZE}px`,
              ...(typeof local.style === "object" ? local.style : {}),
            }
          : local.style
      }
    >
      {local.children}
    </button>
  )
}

// =====================================================================
// The two named icon buttons. Both are BaseButton with the "hud-icon"
// variant — the look, the size and the squircle come from there and are
// never restated here. A wrapper exists to name a ROLE and to carry the
// behavior that role needs (a tooltip, a drag handle), so a call site
// says what the button IS instead of repeating variant/size props.
// =====================================================================

/** An icon button that labels itself with a tooltip. Shared by both roles
 *  below — it is the whole of what they have in common, so neither wrapper
 *  has to reach for Tooltip or for a variant. */
function TooltipIconButton(
  props: BaseButtonProps & { label: string; openDelay?: number; tooltip?: string },
) {
  const [local, rest] = splitProps(props, ["label", "openDelay", "tooltip", "children"])
  return (
    <Tooltip.Root openDelay={local.openDelay ?? 200}>
      <Tooltip.Trigger asChild={(triggerProps) => (
        <BaseButton {...triggerProps({ "aria-label": local.label, ...rest })} variant="hud-icon">
          {local.children}
        </BaseButton>
      )} />
      <Tooltip.Positioner>
        <Tooltip.Content class="tooltip">{local.tooltip ?? local.label}</Tooltip.Content>
      </Tooltip.Positioner>
    </Tooltip.Root>
  )
}

/** The floating view picker's trigger.
 *
 *  No tooltip: the flower it opens spells every view out on the cells
 *  themselves, so a tooltip would only restate what unfolding already shows
 *  — and it would hang over the cells the user is reaching for. The
 *  aria-label carries the same information for assistive tech.
 *
 *  It carries no drag logic of its own either: the gesture is armed on the
 *  view cube's own wrapper, which encloses BOTH the collapsed button and the
 *  open flower, so the control can be grabbed in either state. */
export function ViewButton(props: BaseButtonProps & { label: string }) {
  const [local, rest] = splitProps(props, ["class", "label"])
  return (
    <BaseButton
      {...rest}
      variant="hud-icon"
      aria-label={local.label}
      class={`view-cube-button ${local.class ?? ""}`}
    />
  )
}

/** A HUD panel in its collapsed state: the panel's icon, its title as the
 *  tooltip, occupying the spot the expanded panel would fill. */
export function CollapsedHudButton(props: BaseButtonProps & { label: string }) {
  return <TooltipIconButton {...props} />
}
