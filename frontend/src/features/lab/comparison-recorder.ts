/** Capture the actual two canvases and their shared speech track. The output
 * is a downloadable local recording; no microphone or server upload is used. */
export class ComparisonRecorder {
  private canvas = document.createElement("canvas");
  private context = this.canvas.getContext("2d")!;
  private audio = new AudioContext();
  private destination = this.audio.createMediaStreamDestination();
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private frame = 0;
  private started = 0;
  private media: HTMLAudioElement | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private chunks: Blob[] = [];
  private completed: Promise<Blob> | null = null;
  private stopped = false;
  private speechCompleted = false;

  constructor(
    private left: HTMLCanvasElement,
    private right: HTMLCanvasElement,
    private labels: [string, string],
    private crop?: { x: number; y: number; zoom: number },
    private version?: string
  ) {
    this.canvas.width = 1280;
    this.canvas.height = 720;
  }

  async start(): Promise<void> {
    if (typeof MediaRecorder === "undefined" || !this.canvas.captureStream)
      throw new Error("Video recording is not supported in this browser.");
    await this.audio.resume();
    this.stream = this.canvas.captureStream(30);
    for (const track of this.destination.stream.getAudioTracks()) this.stream.addTrack(track);
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/mp4"].find((type) =>
      MediaRecorder.isTypeSupported(type)
    );
    if (!mimeType) throw new Error("No supported video recording format.");
    this.recorder = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    this.completed = new Promise<Blob>((resolve, reject) => {
      this.recorder!.ondataavailable = (event) => {
        if (event.data.size) this.chunks.push(event.data);
      };
      this.recorder!.onstop = () => resolve(new Blob(this.chunks, { type: mimeType }));
      this.recorder!.onerror = () => reject(new Error("Video recording failed."));
    });
    // The encoder can fail before speech ends; keep the rejection handled
    // until finish() reports it to the recording controls.
    void this.completed.catch(() => {});
    this.started = performance.now();
    this.draw();
    this.recorder.start(250);
  }

  readonly attachAudio = (media: HTMLAudioElement): void => {
    this.media = media;
    media.addEventListener(
      "ended",
      () => {
        this.speechCompleted = true;
      },
      { once: true }
    );
    this.source = this.audio.createMediaElementSource(media);
    this.source.connect(this.destination);
    this.source.connect(this.audio.destination);
  };

  private draw = (): void => {
    const ctx = this.context;
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, 1280, 720);
    ctx.font = "600 22px system-ui";
    ctx.fillStyle = "#ffffff";
    this.labels.forEach((text, i) => ctx.fillText(text, 28 + i * 640, 42));
    for (const [i, source] of [this.left, this.right].entries()) {
      const size = source.width / (this.crop?.zoom ?? 1);
      const x = this.crop ? this.crop.x * source.width - size / 2 : 0;
      const y = this.crop ? this.crop.y * source.height - size / 2 : 0;
      ctx.drawImage(source, x, y, size, size, 16 + i * 640, 64, 608, 608);
    }
    const time = this.media?.currentTime ?? 0;
    ctx.font = "16px system-ui";
    ctx.fillStyle = "#d1d5db";
    ctx.fillText(
      `Liveface · same recording / same cues · ${time.toFixed(2)} s${this.version ? ` · ${this.version}` : ""}`,
      28,
      704
    );
    this.frame = requestAnimationFrame(this.draw);
  };

  async finish(): Promise<Blob> {
    if (!this.recorder || !this.completed) throw new Error("Recording was not started.");
    if (!this.stopped) {
      this.stopped = true;
      cancelAnimationFrame(this.frame);
      if (this.recorder.state !== "inactive") this.recorder.stop();
    }
    try {
      const result = await this.completed;
      if (!this.speechCompleted)
        throw new Error("Recording interrupted. Record again without changing the pose or replaying.");
      return result;
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.source?.disconnect();
    if (this.audio.state !== "closed") void this.audio.close();
  }

  get elapsed(): number {
    return (performance.now() - this.started) / 1000;
  }
}
