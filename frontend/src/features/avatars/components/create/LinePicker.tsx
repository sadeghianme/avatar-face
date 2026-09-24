import { useTranslation } from "react-i18next";

import portraitUrl from "@/assets/demo/portrait.webp";
import { LINE_ORDER, LINES, type LineExample } from "@/features/avatars/lines";
import type { FaceType } from "@/lib/types";

/**
 * Which line the photo is: Human, Animal or Animation, each with a picture
 * of what it means. The human example is the landing page's demo portrait
 * (a generated, fictional face); the other two are drawn here, so the
 * choice costs no new assets and no third-party images.
 */
function Example({ kind }: { kind: LineExample }) {
  if (kind === "portrait") {
    return <img src={portraitUrl} alt="" className="h-full w-full object-cover object-top" loading="lazy" />;
  }
  if (kind === "animal") {
    // A dog, head-on: ears, muzzle, the lip line the animal marks follow.
    return (
      <svg viewBox="0 0 120 120" preserveAspectRatio="xMidYMid slice" className="block h-full w-full" aria-hidden="true">
        <rect width="120" height="120" fill="#e9dcc9" />
        <path d="M26 30c-10 6-14 30-6 44 6-4 10-16 14-26z" fill="#8a5a3b" />
        <path d="M94 30c10 6 14 30 6 44-6-4-10-16-14-26z" fill="#8a5a3b" />
        <ellipse cx="60" cy="62" rx="34" ry="36" fill="#c8915f" />
        <ellipse cx="60" cy="82" rx="20" ry="16" fill="#f1dcc0" />
        <circle cx="46" cy="56" r="5" fill="#2b1d14" />
        <circle cx="74" cy="56" r="5" fill="#2b1d14" />
        <circle cx="47.5" cy="54.5" r="1.4" fill="#fff" />
        <circle cx="75.5" cy="54.5" r="1.4" fill="#fff" />
        <ellipse cx="60" cy="73" rx="7" ry="5" fill="#2b1d14" />
        <path d="M60 78v6M48 86c4 4 8 4 12 0 4 4 8 4 12 0" stroke="#2b1d14" strokeWidth="2" fill="none" strokeLinecap="round" />
      </svg>
    );
  }
  // An animated character: big eyes, flat colour, a drawn mouth.
  return (
    <svg viewBox="0 0 120 120" preserveAspectRatio="xMidYMid slice" className="block h-full w-full" aria-hidden="true">
      <rect width="120" height="120" fill="#dbeafe" />
      <path d="M22 58c0-26 16-40 38-40s38 14 38 40" fill="#4c1d95" />
      <ellipse cx="60" cy="66" rx="32" ry="36" fill="#fcd9b8" />
      <path d="M28 52c6-18 22-26 32-26s26 8 32 26c-10-8-22-10-32-6-10-4-22-2-32 6z" fill="#5b21b6" />
      <ellipse cx="47" cy="66" rx="8" ry="10" fill="#fff" />
      <ellipse cx="73" cy="66" rx="8" ry="10" fill="#fff" />
      <circle cx="48" cy="68" r="5" fill="#0f766e" />
      <circle cx="72" cy="68" r="5" fill="#0f766e" />
      <circle cx="49.5" cy="66" r="1.8" fill="#fff" />
      <circle cx="73.5" cy="66" r="1.8" fill="#fff" />
      <path d="M50 86c6 6 14 6 20 0" stroke="#9f1239" strokeWidth="3" fill="none" strokeLinecap="round" />
      <circle cx="38" cy="80" r="4" fill="#fda4af" opacity="0.6" />
      <circle cx="82" cy="80" r="4" fill="#fda4af" opacity="0.6" />
    </svg>
  );
}

export function LinePicker({
  value,
  suggested,
  onChange,
  disabled = false,
}: {
  value: FaceType | null;
  /** What the analysis suggests (only ever human: see photo_analysis). */
  suggested: FaceType | null;
  onChange: (line: FaceType) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <fieldset disabled={disabled}>
      <legend className="label">{t("createLineQuestion")}</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {LINE_ORDER.map((id) => {
          const line = LINES[id];
          const checked = value === id;
          return (
            <label
              key={id}
              className={`group relative flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors
                has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500 sm:flex-col ${
                  checked
                    ? "border-brand-500 bg-brand-50/70 dark:border-brand-500 dark:bg-brand-500/[0.08]"
                    : "border-gray-200 hover:border-gray-300 dark:border-line dark:hover:border-gray-600"
                }`}
            >
              <input
                type="radio"
                name="creation-line"
                value={id}
                checked={checked}
                onChange={() => onChange(id)}
                className="sr-only"
                aria-describedby={`line-${id}-summary`}
              />
              <span className="block h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-gray-100 sm:h-auto sm:w-full sm:aspect-[4/3] dark:bg-white/[0.06]">
                <Example kind={line.example} />
              </span>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  {t(line.label)}
                  {suggested === id && (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                      {t("createLineSuggested")}
                    </span>
                  )}
                </span>
                <span id={`line-${id}-summary`} className="mt-1 block text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                  {t(line.summary)}
                </span>
              </span>
              {checked && (
                <span className="absolute end-2 top-2 h-2.5 w-2.5 rounded-full bg-brand-600" aria-hidden="true" />
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
