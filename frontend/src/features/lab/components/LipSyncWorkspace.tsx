import type { AvatarEngine } from "@liveface/embed";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { LipSyncPreview } from "@/features/lab/components/LipSyncPreview";
import { SpeechStreamStatus } from "@/features/lab/components/SpeechStreamStatus";
import { useLipSyncComparison } from "@/features/lab/hooks/useLipSyncComparison";
import { defaultVoiceSelection, VoicePicker } from "@/features/voices";
import type { Avatar } from "@/lib/types";

export function LipSyncWorkspace({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  const { t } = useTranslation();
  const [baseline, setBaseline] = useState<AvatarEngine | null>(null);
  const [improved, setImproved] = useState<AvatarEngine | null>(null);
  const [text, setText] = useState<string>(t("lipSyncSample"));
  const [voice, setVoice] = useState(defaultVoiceSelection);
  const baselineReady = useCallback((next: AvatarEngine | null) => setBaseline(next), []);
  const improvedReady = useCallback((next: AvatarEngine | null) => setImproved(next), []);
  const comparison = useLipSyncComparison(orgId, baseline, improved);
  const supported = voice.provider !== "browser" && voice.provider !== "cloned";
  const ready = Boolean(baseline && improved);
  const native = comparison.payload?.timing_source === "native_phonemes";
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className="space-y-4" aria-label={t("lipSyncComparison")}>
        <div className="card grid gap-4 p-4 sm:grid-cols-2">
          <figure>
            <figcaption className="mb-3 text-sm font-medium">{t("lipSyncBaseline")}</figcaption>
            <LipSyncPreview avatar={avatar} onEngine={baselineReady} />
          </figure>
          <figure>
            <figcaption className="mb-3 text-sm font-medium text-brand-600 dark:text-brand-300">
              {t("lipSyncImproved")}
            </figcaption>
            <LipSyncPreview avatar={avatar} clock={comparison.clock} onEngine={improvedReady} />
          </figure>
        </div>
        <div className="card space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{t("lipSyncOneAudio")}</span>
            <span className="font-mono text-xs text-gray-500">
              {comparison.position.toFixed(1)} / {comparison.duration.toFixed(1)} s
            </span>
          </div>
          <progress
            className="h-1.5 w-full accent-orange-500"
            aria-label={t("lipSyncProgress")}
            max={comparison.duration || 1}
            value={comparison.position}
          />
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-secondary"
              disabled={!comparison.payload || !ready || comparison.busy}
              onClick={() => void comparison.replay()}
            >
              {t("lipSyncReplay")}
            </button>
            <button
              className="btn-secondary"
              disabled={!comparison.playing}
              onClick={() => void comparison.togglePause()}
            >
              {t(comparison.paused ? "lipSyncResume" : "lipSyncPause")}
            </button>
            <button
              className="btn-secondary"
              disabled={!comparison.playing && !comparison.busy}
              onClick={comparison.stop}
            >
              {t("stop")}
            </button>
          </div>
          <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t("lipSyncReplayHint")}</p>
        </div>
        <div className="card text-sm" role="status">
          <h3 className="font-semibold">{t(native ? "lipSyncNativeTitle" : "lipSyncClockTitle")}</h3>
          <p className="mt-2 leading-relaxed text-gray-500 dark:text-gray-400">
            {t(!comparison.payload ? "lipSyncBeforeTest" : native ? "lipSyncNativeBody" : "lipSyncFallbackBody")}
          </p>
        </div>
      </section>
      <aside className="card space-y-5">
        <h3 className="text-base font-semibold">{t("lipSyncTestTitle")}</h3>
        <SpeechStreamStatus {...comparison} />
        <VoicePicker
          value={voice}
          onChange={(next) => {
            comparison.stop();
            setVoice(next);
          }}
        />
        {!supported && <p className="text-sm text-amber-700 dark:text-amber-300">{t("lipSyncServerOnly")}</p>}
        <div>
          <label className="label" htmlFor="lip-sync-text">
            {t("lipSyncScript")}
          </label>
          <textarea
            id="lip-sync-text"
            className="input min-h-36"
            value={text}
            maxLength={600}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="mt-1 text-right text-xs text-gray-400">{text.length} / 600</p>
        </div>
        <button
          className="btn-primary w-full"
          disabled={!ready || !supported || !text.trim() || comparison.busy || comparison.playing}
          onClick={() => void comparison.generate(text, voice)}
        >
          {t(comparison.busy ? "lipSyncPreparing" : "lipSyncGenerate")}
        </button>
        {comparison.error && (
          <p role="alert" className="field-error">
            {comparison.error}
          </p>
        )}
        <div className="border-t border-black/10 pt-4 dark:border-white/10">
          <label className="label flex justify-between" htmlFor="lip-sync-lead">
            <span>{t("lipSyncLead")}</span>
            <span>{comparison.lead} ms</span>
          </label>
          <input
            id="lip-sync-lead"
            type="range"
            className="w-full accent-orange-500"
            min={-100}
            max={150}
            step={5}
            value={comparison.lead}
            onChange={(e) => comparison.setLead(Number(e.target.value))}
          />
          <p className="mt-2 text-xs leading-relaxed text-gray-500">{t("lipSyncLeadHint")}</p>
        </div>
        <p className="text-xs leading-relaxed text-gray-500">{t("lipSyncUnchanged")}</p>
      </aside>
    </div>
  );
}
