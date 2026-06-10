import {
  AvatarEngine,
  listen,
  SpeechQueue,
  sttSupported,
  type SynthesisPayload,
} from "@liveface/embed";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, ApiError } from "../lib/api";
import { VoicePicker, type VoiceSelection } from "./VoicePicker";

export function SpeakPanel({
  engine,
  orgId,
}: {
  engine: AvatarEngine | null;
  orgId: string;
}) {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState("");
  const [selection, setSelection] = useState<VoiceSelection>({
    provider: "offline",
    voice: "offline-warm",
    locale: "en-US",
  });
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

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

  useEffect(() => () => queue?.stop(), [queue]);

  const speak = async () => {
    if (!queue || !text.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await queue.speak(text);
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
        onChange={(e) => setText(e.target.value)}
      />
      {error && <p className="field-error">{error}</p>}
      <div className="flex gap-2">
        <button
          className="btn-primary flex-1"
          disabled={!engine || !text.trim() || busy}
          onClick={() => void speak()}
        >
          🗣 {t("speak")}
        </button>
        <button
          className="btn-secondary"
          disabled={!queue}
          onClick={() => {
            queue?.stop();
            setBusy(false);
          }}
        >
          ⏹ {t("stop")}
        </button>
        {sttSupported() && (
          <button
            className="btn-secondary"
            disabled={listening}
            onClick={() => void dictate()}
            title={t("dictate")}
          >
            {listening ? "👂" : "🎤"}
          </button>
        )}
      </div>
    </div>
  );
}
