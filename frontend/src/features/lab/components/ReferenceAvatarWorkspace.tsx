import type { AvatarEngine } from "@liveface/embed";
import { ContinuousMouth } from "@liveface/embed/mouth/continuous-mouth";
import { ReferenceMouth } from "@liveface/embed/mouth/reference-mouth";
import { REFERENCE_POSES } from "@liveface/embed/mouth/reference-mouth-model";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, type ButtonProps } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { ReferenceUpload } from "@/features/lab/api";
import { LipSyncPreview } from "@/features/lab/components/LipSyncPreview";
import { PlaybackButtons, ScriptField } from "@/features/lab/components/PlaybackControls";
import { ReferenceFitControls } from "@/features/lab/components/ReferenceFitControls";
import { ReferencePhotoUpload } from "@/features/lab/components/ReferencePhotoUpload";
import { ReferenceRecording } from "@/features/lab/components/ReferenceRecording";
import { SpeechStreamStatus } from "@/features/lab/components/SpeechStreamStatus";
import { useLipSyncComparison } from "@/features/lab/hooks/useLipSyncComparison";
import { useReferenceProfile } from "@/features/lab/hooks/useReferenceProfile";
import { REFERENCE_AVATAR, REFERENCE_AVATAR_PROFILE, REFERENCE_SCRIPT_ID } from "@/features/lab/reference-avatar";
import { defaultVoiceSelection, VoicePicker } from "@/features/voices";
import type { Avatar } from "@/lib/types";

/** One of a set of choices shown as buttons: the chosen one filled. */
function Toggle({ on, ...props }: ButtonProps & { on: boolean }) {
  return <Button variant={on ? "primary" : "secondary"} aria-pressed={on} {...props} />;
}

const POSE_LABELS: Record<string, string> = {
  rest: "referenceRest",
  closed: "referenceClosed",
  aa: "referenceAA",
  ee: "referenceEE",
  oo: "referenceOO",
  oh: "referenceOH",
  fv: "referenceFV",
  th: "referenceTH",
};

export function ReferenceAvatarWorkspace({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  const { t } = useTranslation();
  const draft = useReferenceProfile(
    orgId,
    avatar.id,
    avatar.id === REFERENCE_AVATAR.id ? REFERENCE_AVATAR_PROFILE : undefined
  );
  const [mouth] = useState(() => new ReferenceMouth(draft.profile));
  const authored = avatar.id === REFERENCE_AVATAR.id;
  const [photographic, setPhotographic] = useState(true);
  const [performance, setPerformance] = useState<ContinuousMouth | null>(null);
  const [oralPhoto, setOralPhoto] = useState<ReferenceUpload | null>(null);
  const [performanceError, setPerformanceError] = useState<"load" | "teeth" | null>(null);
  const [baseline, setBaseline] = useState<AvatarEngine | null>(null);
  const [candidate, setCandidate] = useState<AvatarEngine | null>(null);
  const [pose, setPose] = useState<string | null>("rest");
  const [mouthOnly, setMouthOnly] = useState(false);
  const previews = useRef<HTMLElement>(null);
  const poseRef = useRef(pose);
  poseRef.current = pose;
  const readPose = useCallback(() => (poseRef.current ? REFERENCE_POSES[poseRef.current] : null), []);
  const baselineReady = useCallback((engine: AvatarEngine | null) => setBaseline(engine), []);
  const candidateReady = useCallback((engine: AvatarEngine | null) => setCandidate(engine), []);
  const comparison = useLipSyncComparison(orgId, baseline, candidate, true);
  const [text, setText] = useState<string>(t("lipSyncSample"));
  const [voice, setVoice] = useState(defaultVoiceSelection);
  const supported = voice.provider !== "browser" && voice.provider !== "cloned";
  const ready = Boolean(baseline && candidate);
  useEffect(() => {
    const abort = new AbortController();
    setPerformance(null);
    setPerformanceError(null);
    void ContinuousMouth.load(
      "/lab/reference/performance.json",
      oralPhoto ?? (authored ? "reference" : undefined),
      abort.signal
    )
      .then((value) => {
        if (!abort.signal.aborted) setPerformance(value);
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setPerformanceError(error instanceof Error && error.name === "DentalPhotoError" ? "teeth" : "load");
      });
    return () => abort.abort();
  }, [authored, oralPhoto]);
  useEffect(() => {
    mouth.setProfile(draft.profile);
    performance?.setProfile(draft.profile);
    if (candidate) candidate.tuning.mouthOpen = draft.profile.jawRange;
  }, [mouth, performance, draft.profile, candidate]);
  const freeze = (next: string) => {
    comparison.stop();
    setPose(next);
  };
  const generate = () => {
    setPose(null);
    void comparison.generate(text, voice);
  };
  const replay = () => {
    setPose(null);
    void comparison.replay();
  };

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-5">
        <Card as="section" className="space-y-4" aria-label={t("referencePoseTitle")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold">{t("referencePoseTitle")}</h3>
            <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300">
              {t("referencePrototype")}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Toggle
              on={photographic}
              onClick={() => {
                freeze("rest");
                setPhotographic(true);
              }}
            >
              {t("referencePhotographic")}
            </Toggle>
            <Toggle
              on={!photographic}
              onClick={() => {
                freeze("rest");
                setPhotographic(false);
              }}
            >
              {t("referenceGeometry")}
            </Toggle>
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(POSE_LABELS).map(([key, label]) => (
              <Toggle key={key} on={pose === key} disabled={!ready} onClick={() => freeze(key)}>
                {t(label)}
              </Toggle>
            ))}
          </div>
          <p className="text-xs leading-relaxed text-gray-500">{t("referencePoseHint")}</p>
          <div className="flex gap-2">
            <Toggle on={!mouthOnly} onClick={() => setMouthOnly(false)}>
              {t("referencePortraitView")}
            </Toggle>
            <Toggle on={mouthOnly} onClick={() => setMouthOnly(true)}>
              {t("referenceMouthView")}
            </Toggle>
          </div>
        </Card>
        <section ref={previews} className="grid gap-4 md:grid-cols-2" aria-label={t("referenceCompare")}>
          <figure className="card p-3">
            <figcaption className="mb-3 px-1">
              <h3 className="text-sm font-semibold">{t("referenceBaseline")}</h3>
              <p className="mt-1 text-xs text-gray-500">{t("referenceBaselineHint")}</p>
            </figcaption>
            <LipSyncPreview
              avatar={avatar}
              clock={comparison.clock}
              pose={readPose}
              still
              mouthOnly={mouthOnly}
              onEngine={baselineReady}
            />
          </figure>
          <figure className="card border-brand-300 p-3 dark:border-brand-700">
            <figcaption className="mb-3 px-1">
              <h3 className="text-sm font-semibold text-brand-600 dark:text-brand-300">
                {t(photographic ? "referencePhotographic" : "referenceCandidate")}
              </h3>
              <p className="mt-1 text-xs text-gray-500">
                {t(photographic ? "referencePhotographicHint" : "referenceCandidateHint")}
              </p>
            </figcaption>
            {photographic && !performance ? (
              <div
                className="grid aspect-square place-items-center rounded-xl bg-gray-100 p-6 text-center text-sm dark:bg-gray-800"
                role={performanceError ? "alert" : "status"}
              >
                {t(
                  performanceError === "teeth"
                    ? "referenceTeethPhotoError"
                    : performanceError
                      ? "referencePerformanceError"
                      : "referencePerformanceLoading"
                )}
              </div>
            ) : (
              <LipSyncPreview
                key={photographic ? "photographic" : "geometry"}
                avatar={avatar}
                clock={comparison.clock}
                pose={readPose}
                still
                mouthOnly={mouthOnly}
                mouthExtension={photographic ? performance! : mouth}
                onEngine={candidateReady}
              />
            )}
          </figure>
        </section>
        <Card as="section" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{t("referenceSpeech")}</h3>
            <span className="font-mono text-xs text-gray-500">
              {comparison.position.toFixed(1)} / {comparison.duration.toFixed(1)} s
            </span>
          </div>
          <p className="text-sm leading-relaxed text-gray-500">{t("referenceSameTiming")}</p>
          <progress
            className="h-1.5 w-full accent-orange-500"
            aria-label={t("lipSyncProgress")}
            max={comparison.duration || 1}
            value={comparison.position}
          />
          <PlaybackButtons comparison={comparison} ready={ready} onReplay={replay} onStop={() => freeze("rest")} />
          <p role="status" className="text-xs leading-relaxed text-gray-500">
            {t(
              !comparison.payload
                ? "lipSyncBeforeTest"
                : comparison.payload.timing_source === "native_phonemes"
                  ? "referenceNative"
                  : "referenceFallback"
            )}
          </p>
          <p className="text-xs text-gray-500">{t("lipSyncReplayHint")}</p>
          <ReferenceRecording
            previews={previews}
            enabled={Boolean(comparison.payload && ready && !comparison.busy && !comparison.playing)}
            replay={comparison.replay}
            beforeReplay={() => setPose(null)}
            photographic={photographic}
            mouthOnly={mouthOnly}
          />
        </Card>
        <Card as="section" className="space-y-3">
          <h3 className="font-semibold">{t("referenceAcceptance")}</h3>
          <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-gray-500">
            <li>{t("referenceCheckClosure")}</li>
            <li>{t("referenceCheckTeeth")}</li>
            <li>{t("referenceCheckIdentity")}</li>
          </ul>
          <p className="border-t border-black/10 pt-3 text-xs leading-relaxed text-gray-500 dark:border-white/10">
            {t(photographic ? "referencePhotographicLimit" : "referenceLimit")}
          </p>
        </Card>
      </div>
      <aside className="space-y-5">
        {avatar.quality_note && (
          <p
            role="status"
            className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
          >
            {avatar.quality_note}
          </p>
        )}
        {!authored && (
          <ReferencePhotoUpload
            orgId={orgId}
            purpose="mouth"
            onUploaded={(photo) => {
              freeze("rest");
              setOralPhoto(photo);
              setPhotographic(true);
            }}
          />
        )}
        {!authored && photographic && (
          <p className="text-xs text-gray-500">
            {t(oralPhoto ? "referenceOwnMouthActive" : "referenceFittedMouthActive")}
          </p>
        )}
        {oralPhoto && (
          <Button
            variant="secondary"
            onClick={() => {
              freeze("rest");
              setOralPhoto(null);
            }}
          >
            {t("referenceRemoveMouth")}
          </Button>
        )}
        <ReferenceFitControls
          {...draft}
          continuous={photographic}
          photographic={photographic && (authored || Boolean(oralPhoto))}
        />
        <Card as="section" id="reference-speech" className="scroll-mt-6 space-y-4">
          <h3 className="font-semibold">{t("lipSyncTestTitle")}</h3>
          <SpeechStreamStatus {...comparison} />
          <VoicePicker
            value={voice}
            onChange={(next) => {
              freeze("rest");
              setVoice(next);
            }}
          />
          {!supported && <p className="text-sm text-amber-700 dark:text-amber-300">{t("lipSyncServerOnly")}</p>}
          <ScriptField id={REFERENCE_SCRIPT_ID} text={text} onChange={setText} className="min-h-40" />
          <Button
            fullWidth
            disabled={!ready || !supported || !text.trim() || comparison.busy || comparison.playing}
            onClick={generate}
          >
            {t(comparison.busy ? "lipSyncPreparing" : "lipSyncGenerate")}
          </Button>
          {comparison.error && (
            <p role="alert" className="field-error">
              {comparison.error}
            </p>
          )}
        </Card>
      </aside>
    </div>
  );
}
