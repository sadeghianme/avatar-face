import { type RefObject, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { FieldError } from "@/components/ui/FieldError";
import { ComparisonRecorder } from "@/features/lab/comparison-recorder";
import { REFERENCE_RENDERER_VERSION } from "@/features/lab/reference-avatar";
import { useT } from "@/i18n";

export function ReferenceRecording({
  previews,
  enabled,
  replay,
  beforeReplay,
  photographic,
  mouthOnly,
}: {
  previews: RefObject<HTMLElement>;
  enabled: boolean;
  replay: (onMedia?: (audio: HTMLAudioElement) => void) => Promise<void>;
  beforeReplay: () => void;
  photographic: boolean;
  mouthOnly: boolean;
}) {
  const { t } = useT();
  const [recording, setRecording] = useState(false);
  const [result, setResult] = useState<{ url: string; extension: string; version: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<ComparisonRecorder | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.dispose();
    };
  }, []);
  useEffect(
    () => () => {
      if (result) URL.revokeObjectURL(result.url);
    },
    [result]
  );
  const capture = async () => {
    const canvases = previews.current?.querySelectorAll("canvas");
    if (!canvases || canvases.length !== 2) return;
    setError(null);
    setRecording(true);
    setResult(null);
    const crop = mouthOnly
      ? {
          x: Number(canvases[0].dataset.focusX),
          y: Number(canvases[0].dataset.focusY),
          zoom: Number(canvases[0].dataset.focusZoom),
        }
      : undefined;
    let recorder: ComparisonRecorder | null = null;
    const version = photographic ? REFERENCE_RENDERER_VERSION : "previous-prototype";
    try {
      recorder = new ComparisonRecorder(
        canvases[0],
        canvases[1],
        [t("referenceBaseline"), t(photographic ? "referencePhotographic" : "referenceCandidate")],
        crop,
        version
      );
      active.current = recorder;
      await recorder.start();
      beforeReplay();
      await replay(recorder.attachAudio);
      const blob = await recorder.finish();
      if (mounted.current)
        setResult({ url: URL.createObjectURL(blob), extension: blob.type.includes("mp4") ? "mp4" : "webm", version });
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : t("referenceRecordError"));
    } finally {
      recorder?.dispose();
      active.current = null;
      if (mounted.current) setRecording(false);
    }
  };
  return (
    <div className="space-y-3 border-t border-black/10 pt-4 dark:border-white/10">
      <p className="text-xs leading-relaxed text-gray-500">{t("referenceRecordHint")}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!enabled || recording} onClick={() => void capture()}>
          {t(recording ? "referenceRecording" : "referenceRecord")}
        </Button>
        {result && (
          <ButtonLink href={result.url} download={`liveface-comparison-${result.version}.${result.extension}`}>
            {t("referenceDownloadVideo")}
          </ButtonLink>
        )}
      </div>
      {result && (
        // A recording of the two previews made a moment ago, for the
        // tester's own review: its speech is the script typed beside it,
        // and there is no caption track to give it.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          controls
          playsInline
          src={result.url}
          className="w-full rounded-xl"
          aria-label={t("referenceRecordedComparison")}
        />
      )}
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}
