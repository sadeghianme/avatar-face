/**
 * Phrase-streamed speech: the first word plays before the rest exists.
 *
 * One entry point, `streamSpeech`, drives a response body from
 * `POST /tts/orgs/{org}/stream` into an engine. It handles both modes the
 * server can answer with — ordered PCM phrases, or one whole recording for
 * providers that cannot stream — so callers need no branch of their own.
 */
import type { CuePlayer } from "../browser-tts";
import type { SpeechPlayer } from "../speech";
import { speechErrorOfFrame, speechErrorOfResponse } from "../speech-error";
import type { Cue } from "../types";
import { StreamingSpeechPlayer } from "./player";
import { bufferedRecording, SpeechAssembly, speechEvents, type StreamedSpeech } from "./protocol";

export { SpeechError, speechErrorOfFrame } from "../speech-error";
export { StreamingSpeechPlayer, StreamTimeline } from "./player";
export { bufferedRecording, SpeechAssembly, speechEvents } from "./protocol";
export type { SpeechChunk, StreamedSpeech } from "./protocol";

type Engine = SpeechPlayer & CuePlayer & { updateCueTrack?: (cues: Cue[]) => void };

export interface StreamHandle {
  /** Resolves when playback has finished, or rejects with the stream error:
   *  a SpeechError (its code, detail and status) when the server refused
   *  the request or said why in an error frame. */
  readonly done: Promise<void>;
  /** The complete recording, for no-cost replay, once the stream has ended. */
  readonly recording: Promise<StreamedSpeech>;
  stop(): void;
}

export interface StreamOptions {
  /** Called inside the click gesture; unlocks audio before the network wait. */
  player?: StreamingSpeechPlayer;
  onState?: (state: "playing" | "buffering", first: boolean) => void;
  signal?: AbortSignal;
}

/**
 * Play a phrase stream into an engine.
 *
 * `fetchStream` performs the request (the caller owns auth and error mapping)
 * and must resolve to a Response whose body is the NDJSON stream. Audio is
 * queued as each phrase arrives. If the server answers with a whole
 * recording instead, it plays through the engine's own `playAudio`, exactly
 * as the non-streaming path always has.
 */
export function streamSpeech(
  engine: Engine,
  fetchStream: () => Promise<Response>,
  options: StreamOptions = {}
): StreamHandle {
  const player = options.player ?? new StreamingSpeechPlayer(engine, undefined, options.onState);
  const assembly = new SpeechAssembly();
  let stopped = false;
  let resolveRecording!: (value: StreamedSpeech) => void;
  let rejectRecording!: (error: unknown) => void;
  const recording = new Promise<StreamedSpeech>((resolve, reject) => {
    resolveRecording = resolve;
    rejectRecording = reject;
  });
  recording.catch(() => undefined); // observed through `done`; never unhandled

  const stop = () => {
    if (stopped) return;
    stopped = true;
    player.stop();
    engine.stopSpeech();
  };
  options.signal?.addEventListener("abort", stop, { once: true });

  const done = (async () => {
    const response = await fetchStream();
    if (!response.ok) throw await speechErrorOfResponse(response);
    if (!response.body) throw new Error(`speech stream: ${response.status} without a body`);
    let whole: StreamedSpeech | null = null;
    for await (const event of speechEvents(response.body)) {
      if (stopped) return;
      switch (event.type) {
        case "start":
          break;
        case "chunk": {
          const part = assembly.append(event);
          player.append(part.samples, part.offset, assembly.cues);
          break;
        }
        case "recording":
          whole = bufferedRecording(event);
          break;
        case "done":
          if (whole) {
            // Not a phrase stream: the ordinary path, through the engine.
            player.stop();
            resolveRecording(whole);
            await new Promise<void>((resolve) =>
              engine.playAudio(whole!.audio_b64, whole!.audio_mime, whole!.cues, resolve)
            );
            return;
          }
          resolveRecording(assembly.finish(event));
          player.finish();
          await player.done;
          return;
        case "error":
          // The server's reason, code first (a cloned line never rendered,
          // the month's allowance spent), for the caller to act on.
          throw speechErrorOfFrame(event);
        default:
          throw new Error("Unknown speech event");
      }
    }
    throw new Error("Speech stream ended without finishing");
  })();
  done.catch((error) => {
    rejectRecording(error);
    stop();
  });

  return { done, recording, stop };
}
