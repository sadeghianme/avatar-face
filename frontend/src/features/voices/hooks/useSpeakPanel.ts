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

import {
  BROWSER_PROVIDER,
  CLONED_PROVIDER,
  speechStream,
  useRenderedLines,
  useSpeechLanguages,
} from "@/features/voices/api";
import { defaultVoiceSelection, type VoiceSelection } from "@/features/voices/components/VoicePicker";
import { useT } from "@/i18n";
import { type SpeechFailure, speechFailure } from "@/lib/speechError";

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
 * words (a sample in the chosen language until the member types; with a
 * cloned voice, one of the lines rendered in it), and saying them (the
 * browser's voice, or the server's streamed phrase by phrase) or dictating
 * them. Stop, and leaving, end what is playing. A line that cannot be said
 * is said why, in the member's language (lib/speechError.ts), with its code
 * for the next step: a line a cloned voice was never given can be heard in
 * a server voice instead, without changing the voice chosen.
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
  const select = onSelectionChange ?? setOwnSelection;
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [failure, setFailure] = useState<SpeechFailure | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // A cloned voice plays only what was rendered in it: the lines it has,
  // offered to pick, and the box filled with one of them rather than a
  // sample it was never given (which could only fail).
  const cloned = selection.provider === CLONED_PROVIDER;
  const { data: renderedLines = [] } = useRenderedLines(orgId, cloned ? selection.voice : null, selection.locale);

  // Follow the chosen speech language with a sample IN that language.
  // Pressing Speak on Persian should demonstrate Persian, not an English
  // sentence read by a Persian voice — which is the one thing that makes a
  // language picker feel broken even when it works.
  const { data: languages } = useSpeechLanguages();
  const language = languages?.find((l) => l.locale === selection.locale);
  const sample = cloned && renderedLines.length ? renderedLines[0] : language?.sample;
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
  /** Say the box's words in `voice`. */
  const say = async (voice: VoiceSelection) => {
    if (!text.trim()) return;
    setFailure(null);
    setBusy(true);
    try {
      if (voice.provider === BROWSER_PROVIDER) {
        await browserTts?.speak(text, voice.voice, voice.locale);
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
          () => speechStream(orgId, { text, provider: voice.provider, voice: voice.voice, locale: voice.locale }),
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
      // A refused request (ApiError) or a refusal inside the stream
      // (SpeechError): both carry the server's code and sentence.
      setFailure(speechFailure(t, err));
    } finally {
      setBusy(false);
    }
  };

  /** The server's voice for the chosen language: what "Use a server voice"
   *  says this line in, once, leaving the chosen voice as it is. */
  const serverVoice = (): VoiceSelection =>
    language
      ? { provider: language.provider, voice: language.voice, locale: language.locale }
      : defaultVoiceSelection();

  const dictate = async () => {
    setFailure(null);
    setListening(true);
    try {
      const heard = (said: string) => change({ type: "heard", text: said });
      const transcript = await listen({ lang: i18n.language, interim: heard });
      if (transcript) heard(transcript);
    } catch {
      setFailure({ code: null, text: "Speech recognition failed" });
    } finally {
      setListening(false);
    }
  };

  return {
    selection,
    // A new voice or new words: what failed before is no longer the question.
    setSelection: (next: VoiceSelection) => {
      setFailure(null);
      select(next);
    },
    text,
    setText: (next: string) => {
      setFailure(null);
      change({ type: "typed", text: next });
    },
    busy,
    listening,
    /** Why the last line was not said, and its code; null when it was. */
    failure,
    /** A cloned voice is chosen: its rendered lines are what it can say. */
    cloned,
    renderedLines,
    speak: () => void say(selectionRef.current),
    /** This line once in the server's voice for the language (a cloned
     *  voice has no recording of it); the chosen voice stays. */
    speakInServerVoice: () => void say(serverVoice()),
    stop: () => {
      browserTts?.stop();
      streamRef.current?.stop();
      setBusy(false);
    },
    dictate: () => void dictate(),
  };
}
