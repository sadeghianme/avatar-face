import {
  BrowserTTS,
  type CuePlayer,
  type SpeechPlayer,
  type StreamHandle,
  StreamingSpeechPlayer,
  streamSpeech,
} from "@liveface/embed";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { SERVER_PROVIDER, speechStream } from "@/features/voices/api";
import type { VoiceSelection } from "@/features/voices/components/VoicePicker";
import { cx } from "@/lib/cx";

/** The built-in voice a sample is read in, by the dashboard's language. */
export function sampleVoice(language: string): VoiceSelection {
  if (language.startsWith("fr")) return { provider: SERVER_PROVIDER, voice: "ff_siwis", locale: "fr-FR" };
  return { provider: SERVER_PROVIDER, voice: "af_heart", locale: "en-US" };
}

/** A full-width white button with the brand's play mark (the kit's unstyled Button). */
const PLAY_SAMPLE = cx(
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold shadow-sm transition",
  "border border-gray-200 bg-white text-gray-900 hover:border-brand-300 hover:bg-brand-50/50 [&_svg]:text-brand-600",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60",
  "dark:border-line dark:bg-raised dark:text-white dark:hover:border-brand-500/40"
);

/**
 * One button that makes an avatar say `text`: the play button of a
 * talking preview. The built-in voice of the dashboard's language, streamed
 * (the first phrase plays while the rest is made); when the server cannot
 * speak, the browser's own voice reads it, so the button always does
 * something. Pressed again while speaking, it stops.
 */
export function SampleSpeech({
  engine,
  orgId,
  text,
  labels,
  className,
}: {
  engine: SpeechPlayer | null;
  orgId: string;
  text: string;
  labels: { play: string; stop: string };
  className?: string;
}) {
  const { i18n } = useTranslation();
  const [speaking, setSpeaking] = useState(false);
  const stream = useRef<StreamHandle | null>(null);
  const browser = useMemo(() => (engine ? new BrowserTTS(engine as unknown as CuePlayer) : null), [engine]);

  useEffect(
    () => () => {
      stream.current?.stop();
      browser?.stop();
    },
    [browser]
  );

  const stop = () => {
    stream.current?.stop();
    stream.current = null;
    browser?.stop();
    setSpeaking(false);
  };

  const speak = async () => {
    if (!engine) return;
    setSpeaking(true);
    const voice = sampleVoice(i18n.language);
    try {
      const player = new StreamingSpeechPlayer(
        engine as unknown as ConstructorParameters<typeof StreamingSpeechPlayer>[0]
      );
      await player.unlock();
      const handle = streamSpeech(
        engine as unknown as Parameters<typeof streamSpeech>[0],
        () => speechStream(orgId, { text, ...voice }),
        { player }
      );
      stream.current = handle;
      await handle.done;
    } catch {
      // The server's voice is not there (or the network): the browser's.
      try {
        if (BrowserTTS.supported()) await browser?.speak(text, undefined, voice.locale);
      } catch {
        // nothing more to try; the button comes back
      }
    } finally {
      stream.current = null;
      setSpeaking(false);
    }
  };

  return (
    <Button
      variant="unstyled"
      onClick={() => (speaking ? stop() : void speak())}
      disabled={!engine}
      aria-label={speaking ? labels.stop : labels.play}
      aria-pressed={speaking}
      className={cx(PLAY_SAMPLE, className)}
      icon={<Icon name={speaking ? "stop" : "playTriangle"} className="h-5 w-5" strokeWidth={speaking ? 2 : 1.6} />}
    >
      <span>{speaking ? labels.stop : labels.play}</span>
    </Button>
  );
}
