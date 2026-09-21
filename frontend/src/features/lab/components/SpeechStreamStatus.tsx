import { useTranslation } from "react-i18next";

export function SpeechStreamStatus({ mode, busy, buffering, paused, playing, firstAudioMs, chunks, bufferGaps }: {
  mode: "native_phrases" | "buffered_provider" | null; busy: boolean; buffering: boolean;
  paused: boolean; playing: boolean; firstAudioMs: number | null; chunks: number; bufferGaps: number;
}) {
  const { t } = useTranslation();
  return <div className="rounded-lg bg-gray-50 p-3 text-xs leading-relaxed dark:bg-gray-900" role="status" aria-live="polite">
    <p className="font-medium">{t(mode === "buffered_provider" ? "speechBuffered" : paused ? "speechPaused" : buffering && firstAudioMs !== null ? "speechBuffering" : busy && !playing ? "speechStarting" : playing ? "speechStreaming" : "speechStreamReady")}</p>
    <p className="mt-1 text-gray-500">{t("speechStreamHint")}</p>
    {firstAudioMs !== null && <p className="mt-2 font-mono text-brand-600 dark:text-brand-300">{t("speechFirstAudio", { seconds: (firstAudioMs / 1000).toFixed(2), count: chunks })}<br />{t("speechBufferGaps", { count: bufferGaps })}</p>}
  </div>;
}
