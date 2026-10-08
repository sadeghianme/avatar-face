import {
  BrowserTTS,
  type CuePlayer,
  listen,
  type SpeechPlayer,
  type StreamHandle,
  StreamingSpeechPlayer,
  streamSpeech,
} from "@liveface/embed";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import { BROWSER_PROVIDER, speechStream, useSpeechLanguages } from "@/features/voices/api";
import { defaultVoiceSelection, type VoiceSelection } from "@/features/voices/components/VoicePicker";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";

/** The words in the box, and whether the member wrote them. */
interface Line {
  text: string;
  /** True once the member types: their words are never replaced by a
   *  sample, however many times they change language afterwards. */
  edited: boolean;
}

type LineEvent = { type: "typed"; text: string } | { type: "sample"; text: string } | { type: "heard"; text: string };

function line(state: Line, event: LineEvent): Line {
  switch (event.type) {
    case "typed":
      return { text: event.text, edited: true };
    case "sample":
      return state.edited ? state : { ...state, text: event.text };
    case "heard":
      // Dictation fills the box as the words are heard, as typing would not.
      return { ...state, text: event.text };
  }
}

/**
 * The Speak panel's state: the voice (the caller's when it owns one), the
 * words (a sample in the chosen language until the member types), and
 * saying them (the browser's voice, or the server's streamed phrase by
 * phrase) or dictating them. Stop, and leaving, end what is playing.
 */
export function useSpeakPanel({
  engine,
  orgId,
  selection: controlledSelection,
  onSelectionChange,
}: {
  engine: SpeechPlayer | null;
  orgId: string;
  selection?: VoiceSelection;
  onSelectionChange?: (selection: VoiceSelection) => void;
}) {
  const { t, i18n } = useT();
  // Prefilled rather than empty: an empty box disables Speak, so the first
  // thing the page offers is a dead button and a blank field.
  const [words, change] = useReducer(line, undefined, () => ({ text: t("speakSample"), edited: false }));
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
  const { data: languages } = useSpeechLanguages();
  const sample = languages?.find((l) => l.locale === selection.locale)?.sample;
  useEffect(() => {
    if (sample) change({ type: "sample", text: sample });
  }, [sample]);

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

  const text = words.text;
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
          () => speechStream(orgId, { text, provider: s.provider, voice: s.voice, locale: s.locale }),
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
      const heard = (said: string) => change({ type: "heard", text: said });
      const transcript = await listen({ lang: i18n.language, interim: heard });
      if (transcript) heard(transcript);
    } catch {
      setError("Speech recognition failed");
    } finally {
      setListening(false);
    }
  };

  return {
    selection,
    setSelection,
    text,
    setText: (next: string) => change({ type: "typed", text: next }),
    busy,
    listening,
    error,
    speak: () => void speak(),
    stop: () => {
      browserTts?.stop();
      streamRef.current?.stop();
      setBusy(false);
    },
    dictate: () => void dictate(),
  };
}
