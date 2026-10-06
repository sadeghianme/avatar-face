/**
 * Liveface canvas engine: textured triangle-mesh warp + cue-driven lip-sync.
 *
 * AvatarEngine is the orchestrator: it owns the canvas, the rig and the
 * scene, and sequences the parts that do the work:
 *
 *   engine/picture.ts              the picture laid on the canvas, and what is built on it
 *   engine/geometry.ts             the mesh laid on the canvas, refined
 *   engine/landmarks.ts            the MediaPipe landmark tables
 *   engine/sampling.ts             what the picture looks like
 *   engine/cues.ts                 the cue track, read
 *   engine/voice.ts                the voice: cue track, clock, audio (the 3D engine's too)
 *   engine/speech.ts               the speech in flight, the articulation
 *   engine/motion.ts               blinks, gaze, the head and the body
 *   engine/state.ts                the face state those write
 *   engine/deform.ts               every vertex, this frame
 *   engine/render2d.ts             the frame composed: picture, body, head
 *   engine/mesh-warp.ts            the warped mesh, on the GPU or in 2D
 *   engine/paint-eyes.ts           gaze, lashes, painted lids
 *   engine/paint-mouth.ts          which mouth paints the mouth
 *   engine/paint-classic-mouth.ts  the drawn mouth and its teeth
 *   engine/scene.ts                the scene, the backdrop of a cut-out
 *   engine/frame-loop.ts           the frame loop (the 3D engine's too)
 *   engine/debug.ts                the debug mesh overlay
 *   engine/debug-handle.ts         the console handle, when a page asks for it
 *   engine/seam.ts                 what the tests and the 3D bake pose and
 *                                  read; in no bundle
 *
 * A `destroyed` flag makes mount -> unmount -> mount safe under React
 * StrictMode: the loop and every async callback bail once it is set.
 */
import { mergeTraits, type CharacterTraits } from "./character-mouth";
import { kindProfile, type KindProfile } from "./kind-profile";
import type { MouthExtension, MouthPose } from "./mouth-extension";
import { DEFAULT_TUNING, ZERO_WEIGHTS, type BlendWeights, type Cue, type EngineTuning, type Rig } from "./types";
import { emphasisBeats, utteranceMs } from "./engine/cues";
import { drawDebugMesh } from "./engine/debug";
import { NO_DEBUG_HANDLE, exposeDebugHandle } from "./engine/debug-handle";
import { deformFace } from "./engine/deform";
import { FrameLoop, FrameStep } from "./engine/frame-loop";
import { validInnerRing, type Point } from "./engine/geometry";
import { LANDMARK_COUNT } from "./engine/landmarks";
import { MeshWarp, type WarpMode } from "./engine/mesh-warp";
import { Motion } from "./engine/motion";
import { ClassicMouth } from "./engine/paint-classic-mouth";
import { drawGaze, drawLashes, drawPaintedLids } from "./engine/paint-eyes";
import { paintMouthSurface } from "./engine/paint-mouth";
import { FacePicture } from "./engine/picture";
import { composeFrame, motionTravel, type Layers } from "./engine/render2d";
import { Backdrop, type Scene } from "./engine/scene";
import { SpeechTrack, articulate, easeTongue } from "./engine/speech";
import { restingFace, type FaceState } from "./engine/state";

export { articulationLead, emphasisBeats, prepareCues, type Beat } from "./engine/cues";
export { hingeShare } from "./engine/deform";
export type { Point } from "./engine/geometry";
export type { WarpMode } from "./engine/mesh-warp";
export type { Scene, SceneBackground } from "./engine/scene";

export interface EngineOptions {
  debugMesh?: boolean;
  /**
   * Put this engine on `globalThis.__liveface` for the console and for
   * measurement scripts (the last engine made wins); `destroy()` takes it
   * back. Off by default, so a customer's page gets no globals from the
   * engine: the widget turns it on with `data-debug` on its script tag or
   * `?liveface-debug` in the page's URL (engine/debug-handle.ts).
   */
  debug?: boolean;
  /** Optional mouth renderer (see mouth/). Omitted means the classic mouth. */
  mouthExtension?: MouthExtension;
  pose?: () => MouthPose | null;
  /** Opt-in lab clock, in audio milliseconds. Omitted by all existing pages. */
  cueClock?: () => number;
  /**
   * The "full" framing: the whole picture, contained and centred. Without
   * it (or with `zoom` 1) the "face" framing: the picture composed as a
   * portrait that fills the canvas. Either way the whole picture is drawn;
   * the two are zoom levels of one viewport (viewport.ts).
   */
  fullPhoto?: boolean;
  /** The zoom directly: 1 the face, 0 the whole picture, between in
   *  proportion, up to 1.3 closer in. Wins over `scene.zoom` and `fullPhoto`. */
  zoom?: number;
  /** The scene the avatar is shown in (zoom, pan, background): what the
   *  owner set and published. `setScene` changes it live. */
  scene?: Scene | null;
  /**
   * How the mesh is warped: "auto" (the default) draws it on the GPU
   * (warp-gl.ts) wherever WebGL works and in 2D everywhere else; "2d"
   * forces the Canvas 2D path, for tests and for comparing the two.
   */
  warp?: WarpMode;
}

export class AvatarEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly rig: Rig;
  /** What the rig's line changes in the mouth; today's human renderer
   *  unless the rig names a profile. */
  private readonly profile: KindProfile;
  /** StrictMode guard: async callbacks bail once destroyed. */
  private destroyed = false;
  private readonly frameStep = new FrameStep();
  /** Takes the console handle back (EngineOptions.debug). */
  private readonly releaseDebugHandle: () => void;

  debugMesh: boolean;
  /** Live animation parameters — mutate freely, applied next frame. */
  tuning: EngineTuning = { ...DEFAULT_TUNING };

  // --- The picture ---------------------------------------------------------

  /** The scene: the zoom the viewport is at (1 the face, 0 the whole
   *  picture), the pan, and what is behind a cut-out. */
  private scene: Scene;
  /** What is behind a cut-out, as drawn (scene.ts). */
  private readonly backdrop = new Backdrop(() => !this.destroyed);
  // Layered render path (see setLayers). Null means single-photo.
  private layers: Layers | null = null;
  /** The picture laid on the canvas: the texture, the mesh over it, what
   *  it looks like, the head cut from it (picture.ts). */
  private readonly picture: FacePicture;
  /** The inner-lip ring the classic mouth is built on (validInnerRing). */
  private readonly innerRing: number[];
  /** The owner's settings for a character mouth (jaw, teeth, tongue). */
  private traits: CharacterTraits;

  // --- Animation -----------------------------------------------------------

  /** What the face is doing this frame (state.ts): the tick writes it, the
   *  deformation and the painters read it. */
  private readonly face: FaceState = restingFace();
  /** The speech in flight: cue track, clock, voice (speech.ts). */
  private readonly speech: SpeechTrack;
  /** Blinks, gaze, the head's drift and nods, the body's sway (motion.ts). */
  private readonly motion = new Motion(this.face);
  /** A mouth renderer that moves and paints the mouth instead (mouth/). */
  private mouthExtension?: MouthExtension;
  /** A mouth driver's pose, which wins over the cue track's. */
  private readonly pose?: () => MouthPose | null;
  private readonly frameLoop: FrameLoop;

  // --- Drawing -------------------------------------------------------------

  /** The warped mesh, on the GPU or in 2D (mesh-warp.ts). */
  private readonly meshWarp: MeshWarp;
  /** The classic drawn mouth (paint-classic-mouth.ts). */
  private readonly classicMouth: ClassicMouth;

  constructor(canvas: HTMLCanvasElement, rig: Rig, texture: HTMLImageElement, opts: EngineOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.rig = rig;
    this.profile = kindProfile(rig);
    this.traits = this.profile.traits;
    this.picture = new FacePicture(canvas, rig, this.profile, texture, (pts) =>
      this.motion.measureBody(pts, canvas.height));
    this.speech = new SpeechTrack(opts.cueClock, {
      onSync: (ms) => this.motion.placeBeatWalker(ms),
      onEnded: () => this.finishSpeech(),
    });
    this.mouthExtension = opts.mouthExtension;
    this.pose = opts.pose;
    this.debugMesh = opts.debugMesh ?? false;
    // The zoom: the option, else the scene's, else the framing.
    this.scene = {
      ...(opts.scene ?? {}),
      zoom: opts.zoom ?? opts.scene?.zoom ?? (opts.fullPhoto ? 0 : 1),
    };
    this.backdrop.load(this.scene.background);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const picture = this.picture;
    this.meshWarp = new MeshWarp(canvas, opts.warp ?? "auto", rig.mouth_indices, () => ({
      texture: picture.texture,
      mesh: picture.mesh,
      padEverywhere: !!picture.field || picture.samples.look.flat,
      lowerFace: picture.lowerFace,
    }));
    this.innerRing = validInnerRing(rig);
    this.classicMouth = new ClassicMouth(ctx, this.profile, this.innerRing);
    this.picture.lay(this.scene.zoom ?? 1, this.scene.pan, true);
    this.motion.start(performance.now());
    this.frameLoop = new FrameLoop((now) => {
      this.tick(now);
      this.render();
    });
    this.releaseDebugHandle = opts.debug ? exposeDebugHandle("__liveface", this) : NO_DEBUG_HANDLE;
  }

  /**
   * Switch to the layered render path: real content behind the head.
   *
   * The layers are full-frame images aligned to the original photo's pixels
   * (background may be absent — a cut-out has nothing behind it). With them,
   * the head moves over the body's own pixels and the body sways over a
   * still background, so nothing is ever revealed that does not exist —
   * the punch-out and feathered-cutout machinery of the single-photo path
   * becomes unnecessary and is simply not used.
   */
  setLayers(layers: {
    background?: HTMLImageElement;
    body: HTMLImageElement;
    head: HTMLImageElement;
  }): void {
    if (this.destroyed) return;
    this.layers = layers;
  }

  /**
   * Swap in a sharper copy of the same photo, mid-flight.
   *
   * The widget boots on the 256px thumbnail so a face appears immediately,
   * then upgrades to the full-resolution image when it lands. Everything
   * sampled or derived from the texture is redone, exactly as loading this
   * texture would have done it (picture.ts): the mesh, the cut-out probe,
   * the head layer, and what the picture looks like.
   */
  setTexture(texture: HTMLImageElement): void {
    if (this.destroyed) return;
    this.picture.texture = texture;
    this.picture.lay(this.scene.zoom ?? 1, this.scene.pan, true);
  }

  /**
   * Change the scene live: the zoom and the pan move the viewport (the
   * owner dragging the preview, a slider), the background swaps what is
   * behind a cut-out. A background picture loads in the background and is
   * drawn once it has; one that fails to load leaves the scene transparent
   * and never holds the avatar up.
   */
  setScene(scene: Scene | null | undefined): void {
    if (this.destroyed) return;
    const next: Scene = { ...(scene ?? {}), zoom: scene?.zoom ?? this.scene.zoom ?? 1 };
    const moved =
      next.zoom !== this.scene.zoom ||
      (next.pan?.x ?? 0) !== (this.scene.pan?.x ?? 0) ||
      (next.pan?.y ?? 0) !== (this.scene.pan?.y ?? 0);
    this.scene = next;
    if (moved) this.picture.lay(this.scene.zoom ?? 1, this.scene.pan, false);
    this.backdrop.load(this.scene.background);
  }

  /**
   * The owner's mouth settings for a character mouth (jaw, teeth, tongue),
   * over the profile's own. Ignored by a classic mouth.
   */
  setCharacterTraits(own: Partial<CharacterTraits> | null | undefined): void {
    this.traits = mergeTraits(this.profile.traits, own);
  }

  /**
   * Stop or restart drawing, e.g. when the avatar scrolls out of view
   * (frame-loop.ts). Time does not jump on resume: the tick clamps its
   * step, so the motion carries on rather than lurching.
   */
  setActive(active: boolean): void {
    if (this.destroyed) return;
    this.frameLoop.setActive(active);
  }

  /**
   * The 478 face landmarks at rest, in canvas pixels. Read-only, for
   * overlays drawn in step with the face (a scan effect, a debug view).
   */
  landmarks(): ReadonlyArray<Readonly<Point>> {
    return this.picture.mesh.basePoints.slice(0, LANDMARK_COUNT);
  }

  destroy(): void {
    this.destroyed = true;
    this.frameLoop.stop();
    this.speech.destroy();
    this.meshWarp.destroy();
    this.releaseDebugHandle();
  }

  /**
   * Choose the warp path live: "2d" for the Canvas 2D triangle loop, "auto"
   * for the GPU wherever it works. For the lab's side-by-side and for a
   * page that must not use WebGL.
   */
  setWarp(mode: WarpMode): void {
    if (this.destroyed) return;
    this.meshWarp.setMode(mode);
  }

  /** Which path the next frame takes: "gl" when the GPU warp is ready. */
  warpPath(): "gl" | "2d" {
    return this.meshWarp.path();
  }

  // --- Public speech API -----------------------------------------------------

  /**
   * Play base64 audio with a viseme cue track. Resolves onEnd (also on stop()).
   *
   * Without a `cueClock` option (every page but the lab) cue time is the
   * audio element's own position (media-clock.ts): held at 0 until the voice
   * is actually playing, re-anchored on `playing` and `seeked`, followed
   * every frame, and standing still with the mouth closed while the element
   * is paused. A clock started at play() ran ahead of the voice by however
   * long the audio took to start, for the whole utterance.
   */
  playAudio(audioB64: string, mime: string, cues: Cue[], onEnd?: () => void): void {
    const audio = this.speech.load(audioB64, mime, onEnd ?? null);
    this.speech.begin(cues);
    this.motion.beginSpeech(performance.now(), utteranceMs(cues), emphasisBeats(this.speech.cues));
    this.speech.play(audio, cues.length < 4);
  }

  /** Drive lip-sync from an externally played voice (e.g. speechSynthesis):
   * cues only, no audio element. */
  playCues(cues: Cue[]): void {
    this.speech.stopAudio();
    this.speech.begin(cues);
    const now = performance.now();
    this.speech.startClock(now);
    this.motion.beginSpeech(now, utteranceMs(cues), emphasisBeats(this.speech.cues));
  }

  /**
   * Swap the mouth renderer on a live engine, or pass null for the classic
   * drawn mouth. Progressive like setLayers: the widget is already animating
   * on a thumbnail when the mouth bundle and its assets arrive, and an avatar
   * that waited for them would show nothing in the meantime.
   */
  setMouthExtension(extension: MouthExtension | null): void {
    this.mouthExtension = extension ?? undefined;
  }

  /** Replace a growing external cue track without restarting articulation. */
  updateCueTrack(cues: Cue[]): void {
    // Opt-in streaming extension: append look-ahead without restarting body
    // motion, the articulation smoother, or the speech clock.
    const time = this.speech.cueTime(performance.now());
    this.speech.replaceCues(cues);
    this.motion.setBeats(emphasisBeats(this.speech.cues), time);
  }

  /** Re-align the cue clock to a known position in the track (ms). */
  syncCueTime(ms: number): void {
    this.speech.seek(ms, performance.now());
    this.motion.placeBeatWalker(ms);
  }

  stopSpeech(): void {
    this.speech.stop();
    this.face.targetWeights = { ...ZERO_WEIGHTS };
    this.motion.endSpeech(performance.now());
  }

  isSpeaking(): boolean {
    return this.speech.speaking;
  }

  /** The voice ended on its own: as stopSpeech, then the caller's onEnd. */
  private finishSpeech(): void {
    const onEnd = this.speech.finish();
    this.face.targetWeights = { ...ZERO_WEIGHTS };
    this.motion.endSpeech(performance.now());
    if (onEnd && !this.destroyed) onEnd();
  }

  // --- Animation tick --------------------------------------------------------

  /** The cue track's co-articulated shape now, or rest when the voice is
   *  paused (SpeechTrack.blendedWeights). */
  private blendedCueWeights(now: number): BlendWeights {
    return this.speech.blendedWeights(now, this.rig.visemes, this.tuning.smoothness);
  }

  /** The sound being made now: a mouth driver's, else the cue track's. */
  private visemeNow(now: number): string {
    return this.pose?.()?.viseme ?? this.speech.currentViseme(now);
  }

  private tick(now: number): void {
    const speech = this.speech;
    const face = this.face;
    // Viseme targets: co-articulated blend across cues (+ amplitude
    // fallback when the track is silent but audio clearly isn't).
    const visemeWeights = this.pose?.()?.weights ?? (speech.speaking ? this.blendedCueWeights(now) : { ...ZERO_WEIGHTS });
    const silent = speech.speaking && speech.currentViseme(now) === "sil";
    if (silent) {
      const amp = speech.amplitude();
      if (amp > 0.06) visemeWeights.jawOpen = Math.min(0.5, amp * 1.2);
    }
    // Waiting for the voice to start is not a pause in it. Cue time holds at
    // 0 until the audio plays, which takes hundreds of ms on a phone, and a
    // greeting that opens on /h/ is silence at 0: counted as a pause, it
    // began with a breath, a blink and a glance away before the first word.
    this.motion.notePause(now, silent && !speech.awaitingVoice());
    face.targetWeights = visemeWeights;

    // The frame's step, clamped (frame-loop.ts).
    const dt = this.frameStep.next(now);
    articulate(face.weights, face.targetWeights, dt, this.tuning.smoothness);

    if (this.picture.field) face.tongue = easeTongue(face.tongue, this.visemeNow(now), dt);

    this.motion.update(dt, now, {
      speaking: speech.speaking,
      wordActive: speech.speaking && !silent,
      energy: speech.speaking
        ? Math.min(1, face.weights.jawOpen + face.weights.mouthStretch * 0.5 + speech.amplitude())
        : 0,
      cueTime: () => speech.cueTime(now),
    });
  }

  // --- Deformation -----------------------------------------------------------

  /** Every mesh vertex this frame (deform.ts). */
  private deformedPoints(): Point[] {
    const picture = this.picture;
    return deformFace({
      rig: this.rig,
      mesh: picture.mesh,
      innerRing: this.innerRing,
      face: this.face,
      tuning: this.tuning,
      profile: this.profile,
      field: picture.field,
      traits: this.traits,
      lowerFace: picture.lowerFace,
      mouthExtension: this.mouthExtension,
    });
  }

  // --- Rendering ---------------------------------------------------------------

  private render(): void {
    const ctx = this.ctx;
    const picture = this.picture;
    const pts = this.deformedPoints();
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // The scene's background first, under everything and still.
    this.backdrop.draw(ctx, this.scene.background, picture.cutOut, this.canvas);
    const travel = motionTravel(!!this.layers, picture.cutOut, this.tuning);
    composeFrame({
      ctx,
      picture: picture.mesh.picture,
      texture: picture.texture,
      layers: this.layers,
      cutOut: picture.cutOut,
      head: picture.headGeom,
      headLayer: picture.headLayer,
      headOffset: this.motion.headOffset(picture.headGeom, travel.head),
      bodyLean: this.motion.bodyLean(travel.body),
      drawMesh: (affine) => this.meshWarp.draw(ctx, pts, affine),
      drawFeatures: () => this.paintFeatures(pts),
    });
  }

  /** Everything painted over the warped mesh, in the head's frame: the
   *  eyes, the lids or the lashes, the mouth, the debug mesh. */
  private paintFeatures(pts: Point[]): void {
    const ctx = this.ctx;
    const { texture, mesh, samples } = this.picture;
    const eyes = { texture, texPoints: mesh.texPoints };
    drawGaze(ctx, pts, eyes, this.face.gaze);
    if (this.profile.blink === "lid") drawPaintedLids(ctx, pts, eyes, this.face.blink, this.tuning.blink, samples);
    else drawLashes(ctx, pts, this.face.blink, samples.lashColour);
    paintMouthSurface({
      ctx,
      pts,
      picture: this.picture,
      rig: this.rig,
      face: this.face,
      tuning: this.tuning,
      profile: this.profile,
      traits: this.traits,
      extension: this.mouthExtension,
      classicMouth: this.classicMouth,
      viseme: () => this.visemeNow(performance.now()),
    });
    if (this.debugMesh) drawDebugMesh(ctx, pts, mesh.triangles, this.innerRing);
  }
}
