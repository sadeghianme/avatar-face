import {
  BrowserTTS,
  listen,
  SpeechQueue,
  sttSupported,
  type CuePlayer,
  type SpeechPlayer,
  type SynthesisPayload,
} from "@liveface/embed";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "./Icon";
import { api, ApiError } from "../lib/api";
import {
  BROWSER_PROVIDER,
  VoicePicker,
  defaultVoiceSelection,
  type SpeechLanguage,
  type VoiceSelection,
} from "./VoicePicker";

export function SpeakPanel({
  engine,
  orgId,
  selection: controlledSelection,
  onSelectionChange,
}: {
  engine: SpeechPlayer | null;
  orgId: string;
  /** Controlled when supplied — the avatar page owns it so the embed snippet
   *  can reproduce the voice that was tested. Standalone callers omit both. */
  selection?: VoiceSelection;
  onSelectionChange?: (selection: VoiceSelection) => void;
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

  const queue = useMemo(() => {
    if (!engine) return null;
    return new SpeechQueue(engine, async (chunk): Promise<SynthesisPayload> => {
      const s = selectionRef.current;
      return api.post<SynthesisPayload>(`/tts/orgs/${orgId}/synthesize`, {
        text: chunk,
        provider: s.provider,
        voice: s.voice,
        locale: s.locale,
      });
    });
  }, [engine, orgId]);

  // Free local voices: speechSynthesis plays, the engine just gets cues.
  const browserTts = useMemo(
    () => (engine ? new BrowserTTS(engine as unknown as CuePlayer) : null),
    [engine]
  );

  useEffect(
    () => () => {
      queue?.stop();
      browserTts?.stop();
    },
    [queue, browserTts]
  );

  const speak = async () => {
    if (!text.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const s = selectionRef.current;
      if (s.provider === BROWSER_PROVIDER) {
        await browserTts?.speak(text, s.voice, s.locale);
      } else {
        await queue?.speak(text);
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
    <div className="card flex flex-col gap-4">
      <VoicePicker value={selection} onChange={setSelection} />
      <textarea
        className="input min-h-24"
        placeholder={t("speakPlaceholder")}
        value={text}
        onChange={(e) => {
          setEdited(true);
          setText(e.target.value);
        }}
      />
      {error && <p className="field-error">{error}</p>}
      <div className="flex gap-2">
        <button
          className="btn-primary flex-1"
          disabled={!engine || !text.trim() || busy}
          onClick={() => void speak()}
        >
          <Icon name="speaker" className="me-1.5 inline h-4 w-4" />
          {t("speak")}
        </button>
        <button
          className="btn-secondary"
          disabled={!queue}
          onClick={() => {
            queue?.stop();
            browserTts?.stop();
            setBusy(false);
          }}
        >
          <Icon name="stop" className="me-1.5 inline h-4 w-4" />
          {t("stop")}
        </button>
        {sttSupported() && (
          <button
            className="btn-secondary"
            disabled={listening}
            onClick={() => void dictate()}
            title={t("dictate")}
          >
            <Icon name={listening ? "ear" : "mic"} className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
