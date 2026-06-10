/**
 * Speech-to-text via the browser Web Speech API (free, ~60 languages,
 * partial transcripts). Graceful unsupported path (e.g. Firefox) — callers
 * check sttSupported() first; an optional server-side Whisper provider can
 * sit behind the same interface for privacy or Firefox support.
 */

export interface ListenOptions {
  lang?: string;
  interim?: (text: string) => void;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function sttSupported(): boolean {
  return recognitionCtor() !== null;
}

/** Listen for one utterance; resolves with the final transcript. */
export function listen(options: ListenOptions = {}): Promise<string> {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    return Promise.reject(
      new Error("Speech recognition is not supported in this browser")
    );
  }
  return new Promise((resolve, reject) => {
    const recognition = new Ctor();
    recognition.lang = options.lang ?? navigator.language ?? "en-US";
    recognition.interimResults = Boolean(options.interim);
    recognition.continuous = false;
    let finalText = "";
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim && options.interim) options.interim(finalText + interim);
    };
    recognition.onerror = (event) => reject(new Error(`stt: ${event.error}`));
    recognition.onend = () => resolve(finalText.trim());
    recognition.start();
  });
}
