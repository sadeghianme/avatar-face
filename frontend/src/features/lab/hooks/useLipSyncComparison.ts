import type { AvatarEngine } from "@liveface/embed";
import { AudioClockComparison } from "@liveface/embed/lab/audio-clock";
import { StreamingAudioComparison } from "@liveface/embed/lab/streaming-audio-clock";
import { SpeechAssembly, speechEvents, bufferedRecording, type LabSpeech } from "@liveface/embed/lab/speech-stream";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { VoiceSelection } from "@/features/voices";

export function useLipSyncComparison(orgId: string, baseline: AvatarEngine | null, improved: AvatarEngine | null, sameTiming = false) {
  const player = useRef<AudioClockComparison | null>(null);
  const stream = useRef<StreamingAudioComparison | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const saved = useRef<LabSpeech | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [mode, setMode] = useState<"native_phrases" | "buffered_provider" | null>(null);
  const [firstAudioMs, setFirstAudioMs] = useState<number | null>(null);
  const [chunks, setChunks] = useState(0);
  const [bufferGaps, setBufferGaps] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<LabSpeech | null>(null);
  const [lead, setLead] = useState(0);
  const [position, setPosition] = useState(0);
  const leadRef = useRef(lead);
  leadRef.current = lead;
  const clock = useCallback(() => stream.current?.readTime() ?? player.current?.readTime() ?? 0, []);
  const stop = useCallback(() => {
    generation.current++;
    request.current?.abort(); request.current = null;
    stream.current?.stop(); stream.current = null;
    player.current?.stop();
    setBusy(false); setPlaying(false); setPaused(false); setBuffering(false);
  }, []);

  useEffect(() => {
    setBusy(false); setPlaying(false); setPaused(false); setBuffering(false);
    if (!baseline || !improved) return;
    const next = new AudioClockComparison(baseline, improved);
    next.leadMs = leadRef.current;
    player.current = next;
    return () => {
      generation.current++; request.current?.abort(); request.current = null;
      stream.current?.stop(); stream.current = null;
      next.destroy();
      if (player.current === next) player.current = null;
    };
  }, [baseline, improved, orgId]);
  useEffect(() => {
    if (player.current) player.current.leadMs = lead;
    if (stream.current) stream.current.leadMs = lead;
  }, [lead]);
  useEffect(() => {
    if (!playing && !busy) return;
    const timer = window.setInterval(() => setPosition(stream.current?.position ?? player.current?.media?.currentTime ?? 0), 100);
    return () => clearInterval(timer);
  }, [playing, busy]);

  const play = async (next: LabSpeech, token: number, onMedia?: (audio: HTMLAudioElement) => void) => {
    const transport = player.current;
    if (!transport || token !== generation.current) return;
    setPlaying(true); setPaused(false); setPosition(0);
    await transport.play(next.audio_b64, next.audio_mime, sameTiming ? next.cues : next.baseline_cues, next.cues, onMedia);
    if (token === generation.current) {
      setPosition(next.duration_ms / 1000); setPlaying(false); setPaused(false);
    }
  };
  const generate = async (text: string, voice: VoiceSelection) => {
    stop();
    if (!baseline || !improved || !player.current) return;
    const token = generation.current;
    const abort = new AbortController(); request.current = abort;
    const started = performance.now();
    let timedOut = false;
    const deadline = window.setTimeout(() => { timedOut = true; abort.abort(); }, 180_000);
    setBusy(true); setError(null); setPayload(null); saved.current = null;
    setPosition(0); setDuration(0); setChunks(0); setBufferGaps(0); setFirstAudioMs(null); setMode(null);
    const remember = (next: LabSpeech) => {
      saved.current = next; setPayload(next); setDuration(next.duration_ms / 1000); setBusy(false);
    };
    try {
      // Unsupported browsers/providers retain the tested full-recording path.
      if (voice.provider !== "kokoro" || typeof AudioContext === "undefined") {
        setMode("buffered_provider");
        const next = await api.post<LabSpeech>(`/orgs/${orgId}/lab/lip-sync/synthesize`, { text, ...voice }, abort.signal);
        if (token !== generation.current) return;
        window.clearTimeout(deadline); remember(next); await play(next, token);
        return;
      }
      const transport = new StreamingAudioComparison(baseline, improved, undefined, (state, first) => {
        if (token !== generation.current) return;
        setBuffering(state === "buffering");
        if (state === "playing") setPlaying(true);
        if (first) setFirstAudioMs(Math.round(performance.now() - started));
      });
      transport.leadMs = leadRef.current; stream.current = transport;
      await transport.unlock();
      if (token !== generation.current) return;
      const response = await api.stream(`/orgs/${orgId}/lab/lip-sync/stream`, { text, ...voice }, abort.signal);
      if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) throw new Error("Speech streaming is unavailable");
      const assembly = new SpeechAssembly();
      let streamMode: "native_phrases" | "buffered_provider" | null = null;
      let next: LabSpeech | null = null;
      let complete = false;
      for await (const event of speechEvents(response.body)) {
        if (token !== generation.current) return;
        if (event.type === "error") throw new Error(typeof event.detail === "string" ? event.detail : "Speech streaming failed");
        if (event.type === "start" && !streamMode && event.version === 1
            && (event.mode === "native_phrases" || event.mode === "buffered_provider")) {
          streamMode = event.mode; setMode(streamMode);
          if (streamMode === "buffered_provider") { transport.stop(); stream.current = null; }
        } else if (event.type === "chunk" && streamMode === "native_phrases") {
          const part = assembly.append(event);
          transport.append(part.samples, part.offset, sameTiming ? assembly.cues : assembly.baseline, assembly.cues);
          setChunks(assembly.chunks); setDuration(assembly.samples / assembly.sampleRate);
          setBufferGaps(transport.timeline.bufferGaps);
        } else if (event.type === "recording" && streamMode === "buffered_provider" && !next) {
          next = bufferedRecording(event);
        } else if (event.type === "done" && streamMode) {
          if (streamMode === "native_phrases") next = assembly.finish(event);
          else if (!next || event.chunks !== 0) throw new Error("Incomplete speech recording");
          complete = true; break;
        } else throw new Error("Unexpected speech stream packet");
      }
      if (!complete || !next) throw new Error("Connection lost before speech finished. Please try again.");
      window.clearTimeout(deadline); remember(next);
      if (streamMode === "native_phrases") {
        transport.finish(); await transport.done;
        if (token === generation.current) {
          stream.current = null; setPosition(next.duration_ms / 1000); setPlaying(false); setPaused(false); setBuffering(false);
        }
      } else await play(next, token);
    } catch (reason) {
      if (token === generation.current) {
        stream.current?.stop(); stream.current = null; player.current?.stop(); abort.abort();
        setError(timedOut ? "Speech preparation timed out. Please try again." : reason instanceof Error ? reason.message : "Playback failed");
        setPlaying(false); setPaused(false); setBuffering(false);
      }
    } finally {
      window.clearTimeout(deadline);
      if (token === generation.current) { request.current = null; setBusy(false); }
    }
  };
  const replay = async (onMedia?: (audio: HTMLAudioElement) => void) => {
    stop(); setError(null);
    const token = generation.current;
    try { if (saved.current) await play(saved.current, token, onMedia); }
    catch (reason) {
      if (token === generation.current) { setError(reason instanceof Error ? reason.message : "Playback failed"); setPlaying(false); }
      if (onMedia) throw reason;
    }
  };
  const togglePause = async () => {
    const transport = stream.current ?? player.current;
    if (!transport) return;
    const token = generation.current;
    try {
      if (paused) await transport.resume(); else await transport.pause();
      if (token === generation.current) setPaused(!paused);
    } catch (reason) {
      if (token === generation.current) { stop(); setError(reason instanceof Error ? reason.message : "Playback failed"); }
    }
  };
  return { clock, generate, replay, stop, togglePause, busy, playing, paused, error, payload, lead, setLead, position,
    mode, buffering, firstAudioMs, chunks, duration, bufferGaps };
}
