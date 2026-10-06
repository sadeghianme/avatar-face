import { type ReactNode, useId, useRef, useState } from "react";

import { FileInput } from "@/components/ui/FileInput";
import { Icon, type IconName } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

/**
 * A place to drop a file, or press to pick one: a dashed box that is a
 * button (Enter and Space open the picker), lit while a file is dragged
 * over it. Its accessible name is `labelledBy` (the field's label) plus its
 * own `title`; `hint` describes it. The file goes to `onFile`.
 */
export function DropZone({
  title,
  hint,
  labelledBy,
  accept,
  icon = "image",
  disabled = false,
  onFile,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  /** The id of the label above it, read before its own words. */
  labelledBy?: string;
  accept?: string;
  icon?: IconName;
  disabled?: boolean;
  onFile: (file: File | undefined) => void;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const ids = useId();
  const open = () => {
    if (!disabled) input.current?.click();
  };

  // The file input sits beside the zone, not in it: a control inside a
  // button is a nested interactive control (axe: nested-interactive), and
  // its click would bubble back into the zone's.
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-disabled={disabled || undefined}
        aria-labelledby={cx(labelledBy, `${ids}-title`)}
        aria-describedby={hint ? `${ids}-hint` : undefined}
        className={cx(
          "flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
          dragging
            ? "border-brand-500 bg-brand-50 dark:bg-brand-500/10"
            : "border-gray-300 bg-white hover:border-brand-400 hover:bg-brand-50/40 dark:border-line dark:bg-raised dark:hover:bg-brand-500/[0.06]",
          className
        )}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) onFile(e.dataTransfer.files[0]);
        }}
      >
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
          <Icon name={icon} className="h-6 w-6" />
        </span>
        <p id={`${ids}-title`} className="mt-3 text-sm font-medium text-gray-800 dark:text-gray-100">
          {title}
        </p>
        {hint && (
          <p id={`${ids}-hint`} className="mt-1 max-w-md text-xs text-gray-500 dark:text-gray-400">
            {hint}
          </p>
        )}
      </div>
      <FileInput
        ref={input}
        srOnly
        tabIndex={-1}
        aria-hidden="true"
        accept={accept}
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </>
  );
}
