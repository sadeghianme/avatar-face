import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";

/**
 * The wizard's fixed action bar. NewWizard owns the bar (a landmark at the
 * bottom of the viewport, after the step in the DOM, so Tab reaches it
 * last); each screen puts its own actions in it with <StepFooter>, which
 * renders them there through a portal. The screen keeps its state and its
 * handlers; only where the buttons are drawn moves.
 */
const Slot = createContext<HTMLElement | null>(null);

export const FooterSlot = Slot.Provider;

export function StepFooter({
  back,
  note,
  children,
}: {
  /** The left side: Back (or Cancel). */
  back?: ReactNode;
  /** A short line beside the actions: what holds the primary one. */
  note?: ReactNode;
  /** The right side: secondary actions, then the primary one last. */
  children?: ReactNode;
}) {
  const slot = useContext(Slot);
  if (!slot) return null;
  return createPortal(
    <div className="flex w-full items-center gap-3">
      <div className="flex shrink-0 items-center">{back}</div>
      <div className="ms-auto flex min-w-0 items-center justify-end gap-2 sm:gap-3">
        {note && (
          <div className="hidden min-w-0 max-w-sm text-end text-xs leading-snug text-gray-500 dark:text-gray-400 md:block">
            {note}
          </div>
        )}
        {children}
      </div>
    </div>,
    slot
  );
}

/** Back, as every screen has it on the left of the bar. `compact`: its
 * arrow alone on a phone, where the bar also holds secondary actions. */
export function BackButton({
  onClick,
  disabled,
  compact,
}: {
  onClick: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="btn-secondary min-h-11 min-w-11 px-3 sm:px-4"
      onClick={onClick}
      disabled={disabled}
      aria-label={compact ? t("wzBack") : undefined}
    >
      <Icon name="back" className="h-4 w-4 rtl:-scale-x-100" />
      <span className={compact ? "hidden sm:inline" : ""}>{t("wzBack")}</span>
    </button>
  );
}

/** A secondary action in the bar: its words from a tablet up, and on a phone
 * its short words (`short`) beside the icon: a finger has no hover to show
 * the title, so an icon alone would be a guess. */
export function BarAction({
  icon,
  label,
  onClick,
  short,
  disabled,
  busy,
}: {
  icon: IconName;
  label: string;
  /** One word or two, for the phone's narrow bar. */
  short: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className="btn-secondary min-h-11 min-w-11 px-3 sm:px-4"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {busy ? <Spinner className="h-4 w-4" /> : <Icon name={icon} className="h-4 w-4" />}
      <span className="sm:hidden">{short}</span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

/** The hold note for a phone, where the bar has no room for it: shown in
 * the page above the bar instead. */
export function PhoneNote({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-center text-xs text-gray-500 dark:text-gray-400 md:hidden">
      {children}
    </p>
  );
}
