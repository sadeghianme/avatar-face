import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { CHECKER_STYLE, PICTURE_BACKDROP } from "@/features/avatars/components/wizard/Art";
import { type Version, versionLabel } from "@/features/avatars/wizard";

/**
 * Every picture step 3 made: the upload first, then each AI result in the
 * order made, the newest last. The one in use is marked "Using this";
 * choosing another makes it the picture the avatar is built from (the
 * server's, so a reload shows the same).
 *
 * Two layouts of the same tiles, by CSS alone. On a phone, a row of square
 * thumbnails under the picture, scrolled sideways, each with a word under
 * it. From a laptop up (where PrepareScreen puts it in the right column,
 * under the change box) two to a row, wrapping, each tile a thumbnail with
 * its words beside it, so a change's own words get room.
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
  className = "",
}: {
  versions: Version[];
  selected: string | null;
  /** The version being switched to, while it is. */
  pending: string | null;
  disabled: boolean;
  onChoose: (version: Version) => void;
  /** Where the parent's grid puts it. */
  className?: string;
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
    const at = Math.max(
      0,
      usable.findIndex((v) => v.id === from)
    );
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
    <div className={`min-w-0 ${className}`}>
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
        // The side padding keeps the focus ring inside the scroll box on a
        // phone; the laptop's grid clips nothing.
        className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2 pt-1 lg:mx-0 lg:grid lg:grid-cols-2 lg:gap-x-4 lg:gap-y-2 lg:overflow-visible lg:p-0"
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
              className={`group w-[84px] shrink-0 snap-start text-start focus-visible:outline-none sm:w-[88px] lg:flex lg:w-auto lg:min-w-0 lg:items-center lg:gap-3 lg:rounded-xl lg:p-1 ${
                v.selectable ? "" : "cursor-not-allowed"
              }`}
            >
              <span
                className={`relative block aspect-square overflow-hidden rounded-xl border transition lg:w-16 lg:shrink-0 ${PICTURE_BACKDROP} ${
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
                  <span
                    className="absolute inset-0 grid place-items-center bg-white/60 dark:bg-black/50"
                    aria-hidden="true"
                  >
                    <Spinner className="h-5 w-5 text-brand-600" />
                  </span>
                )}
              </span>
              {/* Under the thumbnail on a phone, one line: "Using this" or
                  the words. Beside it from a laptop up: the words, up to two
                  lines, and "Using this" under them. */}
              <span
                aria-hidden="true"
                className="mt-1.5 block min-w-0 text-xs text-gray-600 dark:text-gray-300 lg:mt-0 lg:flex-1"
              >
                {on && (
                  <span className="block truncate font-semibold text-brand-700 dark:text-brand-300 lg:hidden">
                    {t("wzVersionUsing")}
                  </span>
                )}
                <span
                  className={`${on ? "hidden lg:block lg:text-gray-900 dark:lg:text-white" : "block"} truncate lg:line-clamp-2 lg:whitespace-normal`}
                >
                  {caption}
                </span>
                {on && (
                  <span className="mt-0.5 hidden font-semibold text-brand-700 dark:text-brand-300 lg:block">
                    {t("wzVersionUsing")}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
