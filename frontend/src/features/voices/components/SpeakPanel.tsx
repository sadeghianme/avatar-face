import {
  BrowserTTS,
  type CuePlayer,
  listen,
  type SpeechPlayer,
  type StreamHandle,
  StreamingSpeechPlayer,
  streamSpeech,
  sttSupported,
} from "@liveface/embed";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Textarea } from "@/components/ui/Textarea";
import {
  BROWSER_PROVIDER,
  defaultVoiceSelection,
  type SpeechLanguage,
  VoicePicker,
  type VoiceSelection,
} from "@/features/voices/components/VoicePicker";
import { api, ApiError, fetchStream } from "@/lib/api";

export function SpeakPanel({
  engine,
  orgId,
  selection: controlledSelection,
  onSelectionChange,
  title,
  hint,
}: {
  engine: SpeechPlayer | null;
  orgId: string;
  /** Controlled when supplied — the avatar page owns it so the embed snippet
   *  can reproduce the voice that was tested. Standalone callers omit both. */
  selection?: VoiceSelection;
  onSelectionChange?: (selection: VoiceSelection) => void;
  /** A heading for the card, where it is one section among others (the
   *  avatar page); with a line under it when given. */
  title?: string;
  hint?: string;
}) {
  const { t, i18n } = useTranslation();
  // Prefilled rather than empty: an empty box disables Speak, so the first
  // thing the page offers is a dead button and a blank field.
  const [text, setText] = useState(() => t("speakSample"));
  // True once the user types: their words are never replaced by a sample,
  // however many times they change language afterwards.
  const [edited, setEdited] = useState(false);
  const [ownSelection, setOwnSelection] = useState<VoiceSelection>(defaultVoiceSelection);
  const selection = controlledSelection ?? ownSelection;
  const setSelection = onSelectionChange ?? setOwnSelection;
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // Follow the chosen speech language with a sample IN that language.
  // Pressing Speak on Persian should demonstrate Persian, not an English
  // sentence read by a Persian voice — which is the one thing that makes a
  // language picker feel broken even when it works.
  const { data: languages } = useQuery({
    queryKey: ["tts-languages"],
    queryFn: () => api.get<SpeechLanguage[]>("/tts/languages"),
  });
  const sample = languages?.find((l) => l.locale === selection.locale)?.sample;
  useEffect(() => {
    if (!edited && sample) setText(sample);
  }, [sample, edited]);

  // Free local voices: speechSynthesis plays, the engine just gets cues.
  const browserTts = useMemo(() => (engine ? new BrowserTTS(engine as unknown as CuePlayer) : null), [engine]);

  // The phrase stream in flight, so Stop and unmount can abort it.
  const streamRef = useRef<StreamHandle | null>(null);

  useEffect(
    () => () => {
      browserTts?.stop();
      streamRef.current?.stop();
    },
    [browserTts]
  );

  const speak = async () => {
    if (!text.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const s = selectionRef.current;
      if (s.provider === BROWSER_PROVIDER) {
        await browserTts?.speak(text, s.voice, s.locale);
      } else if (engine) {
        // Streamed: the first phrase plays while the rest is still being
        // made. Providers that cannot stream answer with one recording and
        // it plays exactly as before. The audio context is unlocked here,
        // inside the click, before the network wait.
        const player = new StreamingSpeechPlayer(
          engine as unknown as ConstructorParameters<typeof StreamingSpeechPlayer>[0]
        );
        await player.unlock();
        const handle = streamSpeech(
          engine as unknown as Parameters<typeof streamSpeech>[0],
          () =>
            fetchStream(`/tts/orgs/${orgId}/stream`, {
              text,
              provider: s.provider,
              voice: s.voice,
              locale: s.locale,
            }),
          { player }
        );
        streamRef.current = handle;
        try {
          await handle.done;
        } finally {
          if (streamRef.current === handle) streamRef.current = null;
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(false);
    }
  };

  const dictate = async () => {
    setError(null);
    setListening(true);
    try {
      const transcript = await listen({ lang: i18n.language, interim: setText });
      if (transcript) setText(transcript);
    } catch {
      setError("Speech recognition failed");
    } finally {
      setListening(false);
    }
  };

  return (
    <Card as="section" className="flex flex-col gap-4" aria-label={title}>
      {title && (
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
          {hint && <p className="mt-0.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{hint}</p>}
        </div>
      )}
      <VoicePicker value={selection} onChange={setSelection} />
      <Textarea
        aria-label={t("speakPlaceholder")}
        className="min-h-24"
        placeholder={t("speakPlaceholder")}
        value={text}
        onChange={(e) => {
          setEdited(true);
          setText(e.target.value);
        }}
      />
      {error && <p className="field-error">{error}</p>}
      <div className="flex gap-2">
        <Button
          size="lg"
          icon="speaker"
          className="flex-1"
          disabled={!engine || !text.trim() || busy}
          onClick={() => void speak()}
        >
          {t("speak")}
        </Button>
        <Button
          variant="secondary"
          size="lg"
          icon="stop"
          disabled={!engine}
          onClick={() => {
            browserTts?.stop();
            streamRef.current?.stop();
            setBusy(false);
          }}
        >
          {t("stop")}
        </Button>
        {sttSupported() && (
          <Button
            variant="secondary"
            size="lg"
            className="min-w-11"
            icon={listening ? "ear" : "mic"}
            disabled={listening}
            onClick={() => void dictate()}
            title={t("dictate")}
            aria-label={t("dictate")}
          />
        )}
      </div>
    </Card>
  );
}
