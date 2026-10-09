import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { Button, type ButtonProps } from "@/components/ui/Button";
import type { IconLike } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { cx } from "@/lib/cx";

/** The question in place of the trigger, on a red tint, its answers at the end. */
const QUESTION = cx(
  "flex flex-wrap items-center gap-2 rounded-lg border py-1 pe-1 ps-3 text-sm",
  "border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
);

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
  quiet = false,
  triggerLabel,
  triggerClassName,
  iconClassName,
  disabled,
}: {
  /** The trigger's words. */
  label: string;
  icon?: IconLike;
  iconClassName?: string;
  /** The trigger in the ordinary secondary colours, not red (a row of
   *  small actions where red would shout). */
  quiet?: boolean;
  /** The trigger's accessible name when its words need context
   *  ("Delete the draft of 3 Oct"). */
  triggerLabel?: string;
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
  // Cancelled, the question gives the focus back to the trigger it replaced
  // (it would otherwise fall to the page with the Cancel button it was on).
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const cancel = () => {
    refocus.current = true;
    setAsking(false);
  };
  useEffect(() => {
    if (asking || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [asking]);

  if (!asking) {
    return (
      <Button
        ref={trigger}
        variant="secondary"
        size={size}
        icon={icon}
        iconClassName={iconClassName}
        disabled={disabled}
        aria-label={triggerLabel}
        className={cx(
          !quiet && "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10",
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
    if (event.key === "Escape") cancel();
  };
  return (
    <span role="group" aria-label={question} className={QUESTION}>
      {question}
      <Button
        variant="secondary"
        size={confirmSize}
        // The safe answer takes the focus: Enter twice deletes nothing.
        autoFocus
        onClick={cancel}
        onKeyDown={onKeyDown}
        disabled={busy}
      >
        {cancelLabel}
      </Button>
      <Button
        variant="danger"
        size={confirmSize}
        onClick={onConfirm}
        onKeyDown={onKeyDown}
        disabled={busy}
        aria-busy={busy || undefined}
      >
        {busy ? (
          <>
            {/* The spinner says nothing to a screen reader: the action
                keeps its name while it runs. */}
            <Spinner className="h-4 w-4" />
            <span className="sr-only">{confirmLabel}</span>
          </>
        ) : (
          confirmLabel
        )}
      </Button>
    </span>
  );
}
