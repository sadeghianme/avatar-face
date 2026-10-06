/**
 * The class names behind Button, ButtonLink and IconButton, and the rule for
 * a busy button. Framework-free, so `npm test` checks them without a DOM.
 * The looks themselves are component classes in index.css (`.btn-*`,
 * `.icon-btn-*`), each with its 44px touch size built in.
 */

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "contrast" | "overlay" | "link" | "text";

/**
 * xs 26px · sm 36px · md 36px (the default, `.btn`'s own) · lg 44px (the
 * dashboard's main actions) · xl 48px (the wizard's next step). Every one
 * is 44px under a finger.
 */
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "xl";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  danger: "btn-danger",
  ghost: "btn-ghost",
  contrast: "btn-contrast",
  overlay: "btn-overlay",
  link: "btn-link",
  text: "btn-text",
};

const SIZE: Record<ButtonSize, string> = {
  xs: "btn-xs",
  sm: "btn-sm",
  md: "",
  lg: "btn-lg",
  xl: "btn-xl",
};

/** Link and text buttons sit in a line of text: they have no box to size. */
const UNSIZED: ReadonlySet<ButtonVariant> = new Set(["link", "text"]);

export interface ButtonLook {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

export function buttonClass({ variant = "primary", size = "md", fullWidth = false }: ButtonLook = {}): string {
  return [VARIANT[variant], UNSIZED.has(variant) ? "" : SIZE[size], fullWidth ? "w-full" : ""]
    .filter(Boolean)
    .join(" ");
}

/**
 * A busy button cannot be pressed again and says so to a screen reader;
 * a disabled one is just disabled.
 */
export function pressState({ disabled = false, loading = false }: { disabled?: boolean; loading?: boolean }): {
  disabled: boolean;
  "aria-busy": true | undefined;
} {
  return { disabled: disabled || loading, "aria-busy": loading || undefined };
}

export type IconButtonVariant = "ghost" | "plain" | "danger" | "overlay" | "secondary";

const ICON_VARIANT: Record<IconButtonVariant, string> = {
  // The header's: theme, language, menu.
  ghost: "icon-btn",
  // An icon and nothing around it: a row's quiet action.
  plain: "icon-btn-plain",
  danger: "icon-btn-danger",
  // On a picture: the stage's fullscreen.
  overlay: "icon-btn-overlay",
  // A square secondary button: the framing pad's arrows.
  secondary: "btn-secondary btn-lg min-w-11 px-0",
};

export function iconButtonClass(variant: IconButtonVariant = "ghost"): string {
  return ICON_VARIANT[variant];
}
