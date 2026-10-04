import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CHECKER_STYLE, PICTURE_BACKDROP } from "@/features/avatars/components/wizard/Art";
import { versionLabel, type Version } from "@/features/avatars/wizard";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";

/**
 * Every picture step 3 made, under the main one: the upload first, then
 * each AI result in the order made, the newest last. The one in use is
 * marked "Using this"; choosing another makes it the picture the avatar is
 * built from (the server's, so a reload shows the same).
 *
 * A radio group for assistive tech, one tab stop. The arrow keys move the
 * focus and Enter or Space chooses: switching asks the server, so it does
 * not follow every key press.
 */
export function VersionStrip({
  versions,
  selected,
  pending,
  disabled,
  onChoose,
}: {
  versions: Version[];
  selected: string | null;
  /** The version being switched to, while it is. */
  pending: string | null;
  disabled: boolean;
  onChoose: (version: Version) => void;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const usable = versions.filter((v) => v.selectable);
  const [focus, setFocus] = useState<string | null>(null);
  // The one tab stop: the focused version, else the one in use.
  const stop = focus ?? selected ?? usable[0]?.id ?? null;

  const move = (from: string, step: number) => {
    if (usable.length === 0) return;
    const at = Math.max(0, usable.findIndex((v) => v.id === from));
    const next = usable[(at + step + usable.length) % usable.length];
    setFocus(next.id);
    buttons.current.get(next.id)?.focus();
    buttons.current.get(next.id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const choose = (v: Version) => {
    if (!v.selectable || disabled || v.id === selected) return;
    onChoose(v);
  };

  if (versions.length < 2) return null;
  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p id={`${ids}-label`} className="text-sm font-semibold text-gray-900 dark:text-white">
          {t("wzVersionsLabel")}
          <span className="ms-2 font-normal tabular-nums text-gray-400">{versions.length}</span>
        </p>
        <p id={`${ids}-hint`} className="text-xs text-gray-500 dark:text-gray-400">
          {t("wzVersionsHint")}
        </p>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={`${ids}-label`}
        aria-describedby={`${ids}-hint`}
        className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2 pt-1"
      >
        {versions.map((v) => {
          const on = v.id === selected;
          const label = t(versionLabel(v).key, versionLabel(v).values);
          const caption = v.kind === "change" && v.instruction ? v.instruction : t(`wzVersionShort_${v.kind}`);
          return (
            <button
              key={v.id}
              ref={(el) => {
                buttons.current.set(v.id, el);
              }}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={!v.selectable || disabled || undefined}
              aria-label={label}
              title={v.selectable ? label : t("wzVersionNotUsable")}
              tabIndex={v.id === stop ? 0 : -1}
              onFocus={() => setFocus(v.id)}
              onBlur={() => setFocus(null)}
              onClick={() => choose(v)}
              onKeyDown={(e) => {
                const rtl = document.documentElement.dir === "rtl";
                if (e.key === (rtl ? "ArrowLeft" : "ArrowRight") || e.key === "ArrowDown") {
                  e.preventDefault();
                  move(v.id, 1);
                } else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft") || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(v.id, -1);
                } else if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  choose(v);
                } else if (e.key === "Home" || e.key === "End") {
                  e.preventDefault();
                  const target = e.key === "Home" ? usable[0] : usable[usable.length - 1];
                  if (target) move(target.id, 0);
                }
              }}
              className={`group w-[84px] shrink-0 snap-start text-start focus-visible:outline-none sm:w-[88px] ${
                v.selectable ? "" : "cursor-not-allowed"
              }`}
            >
              <span
                className={`relative block aspect-square overflow-hidden rounded-xl border transition ${PICTURE_BACKDROP} ${
                  on
                    ? "border-brand-500 ring-2 ring-brand-500 ring-offset-2 ring-offset-white dark:ring-offset-ink"
                    : v.selectable
                      ? "border-gray-200 group-hover:border-brand-300 dark:border-line dark:group-hover:border-brand-500/50"
                      : "border-dashed border-gray-300 opacity-60 dark:border-line"
                } group-focus-visible:ring-2 group-focus-visible:ring-brand-500 group-focus-visible:ring-offset-2 dark:group-focus-visible:ring-offset-ink`}
              >
                {v.shown.cutout && <span className="absolute inset-0" style={CHECKER_STYLE} aria-hidden="true" />}
                <img
                  src={v.shown.url}
                  alt={label}
                  className="absolute inset-0 h-full w-full object-cover object-[50%_20%]"
                  draggable={false}
                  loading="lazy"
                />
                <span
                  aria-hidden="true"
                  className="absolute bottom-1 start-1 grid h-5 min-w-5 place-items-center rounded-full bg-black/60 px-1.5 text-[11px] font-semibold tabular-nums text-white backdrop-blur"
                >
                  {v.number}
                </span>
                {on && (
                  <span
                    aria-hidden="true"
                    className="absolute end-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-brand-600 text-white shadow motion-safe:animate-tick-in"
                  >
                    <Icon name="check" className="h-3 w-3" strokeWidth={2.8} />
                  </span>
                )}
                {pending === v.id && (
                  <span className="absolute inset-0 grid place-items-center bg-white/60 dark:bg-black/50" aria-hidden="true">
                    <Spinner className="h-5 w-5 text-brand-600" />
                  </span>
                )}
              </span>
              <span aria-hidden="true" className="mt-1.5 block truncate text-xs text-gray-600 dark:text-gray-300">
                {on ? (
                  <span className="font-semibold text-brand-700 dark:text-brand-300">{t("wzVersionUsing")}</span>
                ) : (
                  caption
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
