import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";

/**
 * The avatar's name as its page's title, edited where it stands: click it
 * (or its pencil, or focus it and press Enter), type, and Enter or leaving
 * the field saves; Escape puts the old name back. An empty or unchanged
 * name saves nothing. A failed save keeps the field open with the words
 * typed and says so.
 */
export function InlineName({ name, onSave }: { name: string; onSave: (next: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const ids = useId();

  useEffect(() => {
    if (!editing) setValue(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const close = () => {
    setEditing(false);
    setFailed(false);
    // Back to the title, where the keyboard was.
    window.requestAnimationFrame(() => trigger.current?.focus());
  };

  const commit = async () => {
    const next = value.trim().slice(0, 128);
    if (!next || next === name) {
      setValue(name);
      close();
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      await onSave(next);
      setSaved(true);
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
          {t("wzRenameLabel")}
        </label>
        <div className="flex items-center gap-2">
          <input
            id={`${ids}-name`}
            ref={input}
            className={`input h-11 min-w-0 max-w-[min(28rem,70vw)] text-xl font-semibold transition-opacity duration-300 ${
              saving ? "opacity-60" : ""
            }`}
            value={value}
            maxLength={128}
            // Saving is a quiet dimming of the same field: no spinner, nothing
            // appears or moves, and the words cannot change under the request.
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
                setValue(name);
                close();
              }
            }}
            onBlur={() => {
              if (!saving) void commit();
            }}
          />
        </div>
        <p id={`${ids}-hint`} className={`mt-1 text-xs ${failed ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}`} role={failed ? "alert" : undefined}>
          {failed ? t("wzRenameFailed") : t("wzRenameHint")}
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
        className="group -mx-1.5 inline-flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-0.5 text-start coarse:min-h-11 hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-white/[0.06]"
        aria-label={`${name}. ${t("wzRename")}`}
        title={t("wzRename")}
      >
        <h1 className="truncate text-2xl font-semibold">{name}</h1>
        <Icon name="pencil" className="h-4 w-4 shrink-0 text-gray-400 opacity-60 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </button>
      <span role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
        {saved ? t("wzRenameSaved") : ""}
      </span>
    </span>
  );
}
