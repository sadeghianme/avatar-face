/**
 * The AudioWorklet speech-timing-page.ts records with, served beside it as
 * /recorder.js: every sample that reaches it, in chunks stamped with the
 * context frame of their first sample. Its output is silence.
 */
export const RECORDER = `
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(8192);
    this.fill = 0;
    this.start = 0;
    this.on = true;
    this.port.onmessage = () => { this.flush(); this.on = false; this.port.postMessage("stopped"); };
  }
  flush() {
    if (this.fill) this.port.postMessage({ frame: this.start, data: this.chunk.slice(0, this.fill) });
    this.fill = 0;
  }
  process(inputs) {
    if (!this.on) return false;
    const channel = inputs[0] && inputs[0][0];
    if (this.fill === 0) this.start = currentFrame;
    for (let i = 0; i < 128; i++) this.chunk[this.fill + i] = channel ? channel[i] : 0;
    this.fill += 128;
    if (this.fill + 128 > this.chunk.length) this.flush();
    return true;
  }
}
registerProcessor("recorder", Recorder);
`;
