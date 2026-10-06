import { useEffect, useId, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

export interface InlineEditLabels {
  /** The field's label, for a screen reader. */
  field: string;
  /** "Rename": the title's tooltip, and after its name for a screen reader. */
  edit: string;
  /** Under the field while editing. */
  hint: string;
  /** Under the field when a save failed. */
  failed: string;
  /** Beside the title for a moment after a save. */
  saved: string;
}

/**
 * A title edited where it stands: click it (or its pencil, or focus it and
 * press Enter), type, and Enter or leaving the field saves; Escape puts the
 * old text back. An empty or unchanged text saves nothing. A failed save
 * keeps the field open with the words typed and says so. Saving dims the
 * field: no spinner, nothing moves, the words cannot change under the
 * request.
 */
export function InlineEdit({
  value: saved,
  onSave,
  labels,
  maxLength = 128,
}: {
  value: string;
  onSave: (next: string) => Promise<void>;
  labels: InlineEditLabels;
  maxLength?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const ids = useId();

  useEffect(() => {
    if (!editing) setValue(saved);
  }, [saved, editing]);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 2000);
    return () => window.clearTimeout(timer);
  }, [done]);

  const close = () => {
    setEditing(false);
    setFailed(false);
    // Back to the title, where the keyboard was.
    window.requestAnimationFrame(() => trigger.current?.focus());
  };

  const commit = async () => {
    const next = value.trim().slice(0, maxLength);
    if (!next || next === saved) {
      setValue(saved);
      close();
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      await onSave(next);
      setDone(true);
      close();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="min-w-0">
        <label htmlFor={`${ids}-name`} className="sr-only">
          {labels.field}
        </label>
        <div className="flex items-center gap-2">
          <input
            id={`${ids}-name`}
            ref={input}
            className={cx(
              "input h-11 min-w-0 max-w-[min(28rem,70vw)] text-xl font-semibold transition-opacity duration-300",
              saving && "opacity-60"
            )}
            value={value}
            maxLength={maxLength}
            readOnly={saving}
            aria-busy={saving || undefined}
            aria-describedby={`${ids}-hint`}
            aria-invalid={failed || undefined}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setValue(saved);
                close();
              }
            }}
            onBlur={() => {
              if (!saving) void commit();
            }}
          />
        </div>
        <p
          id={`${ids}-hint`}
          className={cx("mt-1 text-xs", failed ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400")}
          role={failed ? "alert" : undefined}
        >
          {failed ? labels.failed : labels.hint}
        </p>
      </div>
    );
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <button
        ref={trigger}
        type="button"
        onClick={() => setEditing(true)}
        className="group -mx-1.5 inline-flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-0.5 text-start hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 coarse:min-h-11 dark:hover:bg-white/[0.06]"
        aria-label={`${saved}. ${labels.edit}`}
        title={labels.edit}
      >
        <h1 className="truncate text-2xl font-semibold">{saved}</h1>
        <Icon
          name="pencil"
          className="h-4 w-4 shrink-0 text-gray-400 opacity-60 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </button>
      <span role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
        {done ? labels.saved : ""}
      </span>
    </span>
  );
}
