import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { CHECKER_STYLE, LookPicture, PICTURE_BACKDROP } from "@/features/avatars/components/wizard/Art";
import type { CreationStep } from "@/features/avatars/creation";
import { type AvatarModel, checklistRow, type Look, type PrepareStage } from "@/features/avatars/wizard";

/** The square every picture of step 3 sits in: the same size loading,
 * compared and done, so nothing jumps when the result arrives. */
const STAGE = "relative aspect-square w-full overflow-hidden rounded-3xl border border-gray-200 dark:border-line";

/**
 * Step 3 at work: never a blank wait. The photo (or, for a character made
 * from words, a soft sketch of one in the chosen look) sits under a
 * shimmer with a scan line passing over it, and the stages are ticked off
 * underneath as the server reports them, with a real progress bar.
 * `compact` lays the same over a result being redone.
 */
export function Working({
  before,
  model,
  look,
  stages,
  stage,
  fraction,
  hint,
}: {
  before: CreationStep | null;
  model: AvatarModel;
  look: Look;
  stages: PrepareStage[];
  stage: PrepareStage | null;
  fraction: number | null;
  hint: string;
}) {
  const { t } = useTranslation();
  const at = checklistRow(stage, stages);
  const shown = stage === "queued" ? t("wzStage_queued") : stage ? t(`wzStage_${stage}`) : t("wzStage_create");
  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:items-center">
      <div className={`${STAGE} ${PICTURE_BACKDROP}`}>
        {before ? (
          <img
            src={before.url}
            alt=""
            className="absolute inset-0 h-full w-full scale-105 object-contain opacity-70 blur-[2px] saturate-50"
          />
        ) : (
          <LookPicture
            model={model}
            look={look}
            className="absolute inset-0 h-full w-full opacity-30 blur-[2px] motion-safe:animate-float-slow"
          />
        )}
        {/* Shimmer and scan line: motion only for those who want it. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[linear-gradient(110deg,transparent_30%,rgba(255,255,255,0.45)_50%,transparent_70%)] bg-[length:250%_100%] motion-safe:animate-shimmer dark:bg-[linear-gradient(110deg,transparent_30%,rgba(255,255,255,0.08)_50%,transparent_70%)]"
        />
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1/3 motion-safe:animate-scan">
          <div className="h-full bg-gradient-to-b from-transparent via-brand-400/25 to-transparent" />
          <div className="h-0.5 bg-brand-500/70 shadow-[0_0_18px_4px_rgba(249,115,22,0.45)]" />
        </div>
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/55 to-transparent p-4 pt-10 text-sm font-medium text-white">
          <Spinner className="h-4 w-4 shrink-0" />
          <span className="truncate">{shown}…</span>
        </div>
      </div>
      <div>
        <ol className="space-y-3">
          {stages.map((s, i) => {
            const done = at > i;
            const current = at === i;
            return (
              <li key={s} className="flex items-center gap-3 text-sm">
                <span
                  aria-hidden="true"
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border ${
                    done
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : current
                        ? "border-brand-500 bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300"
                        : "border-gray-200 text-gray-300 dark:border-line dark:text-gray-600"
                  }`}
                >
                  {done ? (
                    <Icon name="check" className="h-4 w-4 motion-safe:animate-tick-in" strokeWidth={2.6} />
                  ) : current ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  )}
                </span>
                <span
                  className={
                    current
                      ? "font-semibold text-gray-900 dark:text-white"
                      : done
                        ? "text-gray-600 dark:text-gray-300"
                        : "text-gray-400 dark:text-gray-500"
                  }
                >
                  {t(`wzStage_${s}`)}
                  {done && <span className="sr-only"> ({t("wzStageDone")})</span>}
                </span>
              </li>
            );
          })}
        </ol>
        <div
          className="mt-5 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-white/[0.06]"
          role="progressbar"
          aria-label={shown}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={fraction !== null ? Math.round(fraction * 100) : undefined}
        >
          <div
            className={`h-full rounded-full bg-brand-500 transition-[width] duration-700 ease-out ${
              fraction === null ? "w-1/3 motion-safe:animate-pulse" : ""
            }`}
            style={fraction !== null ? { width: `${Math.max(6, Math.round(fraction * 100))}%` } : undefined}
          />
        </div>
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{hint}</p>
      </div>
    </div>
  );
}

/** The stage the result is compared on: the RESULT's own shape (an AI
 * picture is often tall, the upload square), so the result fills it. */
const RESULT_STAGE = "relative w-full overflow-hidden rounded-3xl border border-gray-200 dark:border-line";

/**
 * The result, big. With a "before" (an upload), a slider compares them:
 * drag the handle, or use the arrow keys on it (a real range input, so a
 * screen reader hears where it is). Without one, the result alone. A
 * picture whose background came off sits on a checkerboard, so "no
 * background" is visible. `busy` dims it under a spinner while it is redone.
 *
 * The stage takes the result's aspect ratio and both pictures are drawn
 * whole (contain): the result fills it, the upload sits letterboxed on the
 * same stage. Drawing both "cover" into one square cropped them
 * differently whenever their shapes differed (a whole head before, half a
 * face after).
 */
export function Result({
  before,
  after,
  busy,
  busyLabel,
  badge,
}: {
  before: CreationStep | null;
  after: CreationStep;
  busy: boolean;
  busyLabel: string;
  badge?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [split, setSplit] = useState(50);
  const ids = useId();
  const transparent = Boolean(after.cutout);
  // Both pictures fill the same square the same way (cover, centred), so
  // they line up. The After sits on its own OPAQUE backdrop (white or ink
  // under the tinted gradient, which is translucent): a cut-out's clear
  // parts must not show the Before through them.
  const afterLayer = (
    <div className="absolute inset-0 overflow-hidden bg-white dark:bg-ink">
      <div className={`absolute inset-0 ${PICTURE_BACKDROP}`} />
      {transparent && <div className="absolute inset-0" style={CHECKER_STYLE} />}
      <img
        src={after.url}
        alt={t("wzAfter")}
        className="absolute inset-0 h-full w-full object-contain"
        draggable={false}
      />
    </div>
  );
  return (
    <div
      className={`${RESULT_STAGE} ${PICTURE_BACKDROP} select-none`}
      style={{ aspectRatio: `${Math.max(1, after.width)} / ${Math.max(1, after.height)}` }}
    >
      {before ? (
        <>
          <img
            src={before.url}
            alt={t("wzBefore")}
            className="absolute inset-0 h-full w-full object-contain"
            draggable={false}
          />
          <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
            {afterLayer}
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.12)]"
            style={{ left: `${split}%` }}
          >
            <span className="absolute left-1/2 top-1/2 grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-gray-700 shadow-lg ring-1 ring-black/10">
              <Icon name="sliders" className="h-4 w-4 rotate-90" />
            </span>
          </div>
          <span className="pointer-events-none absolute start-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur">
            {t("wzBefore")}
          </span>
          <span className="pointer-events-none absolute end-3 top-3 rounded-full bg-brand-600 px-2.5 py-1 text-xs font-medium text-white shadow">
            {t("wzAfter")}
          </span>
          <label htmlFor={`${ids}-split`} className="sr-only">
            {t("wzCompare")}
          </label>
          <input
            id={`${ids}-split`}
            type="range"
            min={0}
            max={100}
            value={split}
            onChange={(e) => setSplit(Number(e.target.value))}
            className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0 focus-visible:opacity-0"
            aria-valuetext={`${split}%`}
          />
          <FocusRing />
        </>
      ) : (
        afterLayer
      )}
      {badge && <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center">{badge}</div>}
      {busy && (
        <div className="absolute inset-0 grid place-items-center bg-white/60 backdrop-blur-[2px] dark:bg-black/50">
          <p className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium shadow-lg dark:bg-raised">
            <Spinner className="h-4 w-4 text-brand-600" /> {busyLabel}
          </p>
        </div>
      )}
    </div>
  );
}

/** The range input is invisible; its focus shows on the whole picture. */
function FocusRing() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-3xl ring-brand-500 ring-offset-0 [input:focus-visible~&]:ring-2"
    />
  );
}
