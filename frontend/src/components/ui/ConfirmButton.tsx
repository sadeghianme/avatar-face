import { useState, type KeyboardEvent } from "react";

import { Button, type ButtonProps } from "@/components/ui/Button";
import type { IconLike } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { cx } from "@/lib/cx";

/**
 * A destructive action that asks once, in place: pressed, the button
 * becomes its question with Cancel (focused) and the action; Escape is
 * Cancel. For a question that needs more than a line, use Dialog.
 *
 * Remount it (`key`) to drop a half-asked question when what it acts on
 * changes.
 */
export function ConfirmButton({
  label,
  icon,
  question,
  confirmLabel,
  cancelLabel,
  onConfirm,
  busy = false,
  size = "lg",
  confirmSize = "md",
  triggerClassName,
  disabled,
}: {
  /** The trigger's words. */
  label: string;
  icon?: IconLike;
  /** The question, also the group's accessible name. */
  question: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  /** The action is running: both answers wait, a spinner in the action. */
  busy?: boolean;
  /** The trigger's size. */
  size?: ButtonProps["size"];
  /** The two answers' size. */
  confirmSize?: ButtonProps["size"];
  triggerClassName?: string;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <Button
        variant="secondary"
        size={size}
        icon={icon}
        disabled={disabled}
        className={cx(
          "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10",
          triggerClassName
        )}
        onClick={() => setAsking(true)}
      >
        {label}
      </Button>
    );
  }

  // Escape on either answer is Cancel.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") setAsking(false);
  };
  return (
    <span
      role="group"
      aria-label={question}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 py-1 pe-1 ps-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
    >
      {question}
      <Button
        variant="secondary"
        size={confirmSize}
        // The safe answer takes the focus: Enter twice deletes nothing.
        autoFocus
        onClick={() => setAsking(false)}
        onKeyDown={onKeyDown}
        disabled={busy}
      >
        {cancelLabel}
      </Button>
      <Button variant="danger" size={confirmSize} onClick={onConfirm} onKeyDown={onKeyDown} disabled={busy}>
        {busy ? <Spinner className="h-4 w-4" /> : confirmLabel}
      </Button>
    </span>
  );
}
