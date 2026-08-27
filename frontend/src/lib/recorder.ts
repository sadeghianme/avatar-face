/**
 * Record from the microphone and hand back a 16-bit mono WAV.
 *
 * MediaRecorder produces webm/opus, which the cloning model cannot read —
 * so the compressed recording is decoded back to PCM with an AudioContext
 * and re-encoded as WAV here in the browser. That keeps the server contract
 * dead simple (it stores and serves WAV, nothing else) and means no
 * transcoding dependency anywhere on the backend.
 */

export interface Recording {
  blob: Blob;        // audio/wav, 16-bit PCM mono
  seconds: number;
  url: string;       // object URL for local playback; caller revokes
}

export class MicRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Voice cloning wants the voice, not the room: these are the
        // browser's own cleanup passes, and leaving them on is the
        // difference between "recorded on a laptop" and "recorded in a tin".
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data);
    };
    this.recorder.start();
  }

  async stop(): Promise<Recording> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("not recording");
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await stopped;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.recorder = null;
    this.stream = null;

    const compressed = new Blob(this.chunks, { type: recorder.mimeType });
    const wav = await toWav(compressed);
    return wav;
  }

  cancel(): void {
    this.recorder?.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
  }
}

async function toWav(compressed: Blob): Promise<Recording> {
  const raw = await compressed.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(raw);
    // Mono: average the channels. The model expects one voice, one channel.
    const length = decoded.length;
    const mono = new Float32Array(length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const data = decoded.getChannelData(channel);
      for (let i = 0; i < length; i++) mono[i] += data[i] / decoded.numberOfChannels;
    }
    const blob = encodeWav(mono, decoded.sampleRate);
    return {
      blob,
      seconds: length / decoded.sampleRate,
      url: URL.createObjectURL(blob),
    };
  } finally {
    void ctx.close();
  }
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped * 32767, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
