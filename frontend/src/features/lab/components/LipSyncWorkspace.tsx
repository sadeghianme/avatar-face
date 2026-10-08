import type { AvatarEngine } from "@liveface/embed";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FieldError } from "@/components/ui/FieldError";
import { Slider } from "@/components/ui/Slider";
import { LipSyncPreview } from "@/features/lab/components/LipSyncPreview";
import { PlaybackButtons, ScriptField } from "@/features/lab/components/PlaybackControls";
import { SpeechStreamStatus } from "@/features/lab/components/SpeechStreamStatus";
import { useLipSyncComparison } from "@/features/lab/hooks/useLipSyncComparison";
import { defaultVoiceSelection, VoicePicker } from "@/features/voices";
import { useT } from "@/i18n";
import type { Avatar } from "@/lib/types";

export function LipSyncWorkspace({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  const { t } = useT();
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
        <Card className="grid gap-4 p-4 sm:grid-cols-2">
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
        </Card>
        <Card className="space-y-3">
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
          <PlaybackButtons comparison={comparison} ready={ready} />
          <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t("lipSyncReplayHint")}</p>
        </Card>
        <Card className="text-sm" role="status">
          <h3 className="font-semibold">{t(native ? "lipSyncNativeTitle" : "lipSyncClockTitle")}</h3>
          <p className="mt-2 leading-relaxed text-gray-500 dark:text-gray-400">
            {t(!comparison.payload ? "lipSyncBeforeTest" : native ? "lipSyncNativeBody" : "lipSyncFallbackBody")}
          </p>
        </Card>
      </section>
      <Card as="aside" className="space-y-5">
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
        <ScriptField id="lip-sync-text" text={text} onChange={setText} className="min-h-36" />
        <Button
          fullWidth
          disabled={!ready || !supported || !text.trim() || comparison.busy || comparison.playing}
          onClick={() => void comparison.generate(text, voice)}
        >
          {t(comparison.busy ? "lipSyncPreparing" : "lipSyncGenerate")}
        </Button>
        {comparison.error && <FieldError>{comparison.error}</FieldError>}
        <div className="border-t border-black/10 pt-4 dark:border-white/10">
          <Slider
            id="lip-sync-lead"
            label={t("lipSyncLead")}
            readout={`${comparison.lead} ms`}
            readoutClassName=""
            min={-100}
            max={150}
            step={5}
            value={comparison.lead}
            onChange={comparison.setLead}
          />
          <p className="mt-2 text-xs leading-relaxed text-gray-500">{t("lipSyncLeadHint")}</p>
        </div>
        <p className="text-xs leading-relaxed text-gray-500">{t("lipSyncUnchanged")}</p>
      </Card>
    </div>
  );
}
