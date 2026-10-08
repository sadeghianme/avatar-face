/**
 * Liveface canvas engine: textured triangle-mesh warp + cue-driven lip-sync.
 *
 * AvatarEngine is the orchestrator: it owns the canvas, the rig and the
 * scene, and sequences the parts that do the work, all under engine/. From
 * outside it, engine/ imports only the contracts (types.ts,
 * mouth-extension.ts) and the enamel model it shares with the continuous
 * mouth (mouth/lip-occlusion-model.ts):
 *
 * The picture
 *   engine/picture.ts              the picture laid on the canvas, and what is built on it
 *   engine/viewport.ts             where it lies: the zoom and the pan
 *   engine/geometry.ts             the mesh laid on the canvas, refined
 *   engine/landmarks.ts            the MediaPipe landmark tables
 *   engine/jaw-rig.ts              the lower face as one rig: jaw, chin, cheeks, neck band
 *   engine/kind-profile.ts         what a line of faces (human, toon, animal) changes
 *   engine/sampling.ts             what the picture looks like
 *   engine/face-light.ts           its brightest skin, the teeth's ceiling
 *   engine/face-sharpness.ts       how sharp its edges are
 * Time
 *   engine/cues.ts                 the cue track, read
 *   engine/voice.ts                the voice: cue track, clock, audio (the 3D engine's too)
 *   engine/media-clock.ts          the audio element's own position, as the cue clock
 *   engine/speech.ts               the speech in flight, the articulation
 *   engine/motion.ts               blinks, gaze, the head and the body, from
 *   engine/blink.ts                  when to blink
 *   engine/headmotion.ts             where the head is going (the rigid "2d" motion)
 *   engine/head-personality.ts       where it is turning (the "3d" motion)
 *   engine/bodymotion.ts             the sway and the breath
 *   engine/state.ts                the face state those write
 *   engine/frame-loop.ts           the frame loop (the 3D engine's too)
 * The frame
 *   engine/deform.ts               every vertex, this frame, with
 *   engine/head-turn.ts              the head's turn in depth
 *   engine/canonical-face.ts         the depth it is given
 *   engine/neck-blend.ts             a layered avatar's neck, from head to body
 *   engine/render2d.ts             the frame composed: picture, body, head
 *   engine/mesh-warp.ts            the warped mesh, on the GPU or in 2D, with
 *   engine/warp-gl.ts                the GPU path
 *   engine/seam-pad.ts               the overlap that hides the seams between triangles
 *   engine/paint-eyes.ts           gaze, lashes, and
 *   engine/blink-lid.ts              the painted lids
 *   engine/paint-mouth.ts          which mouth paints the mouth:
 *   engine/paint-classic-mouth.ts    the drawn mouth and its teeth, in
 *   engine/mouth-aperture.ts         the aperture the lips part to
 *   engine/character-mouth.ts        a character's or an animal's mouth, and
 *   engine/character-paint.ts        its painting
 *   engine/scene.ts                the scene, the backdrop of a cut-out
 *   engine/debug.ts                the debug mesh overlay
 *   engine/debug-handle.ts         the console handle, when a page asks for it
 *   engine/seam.ts                 what the tests and the 3D bake pose and
 *                                  read; in no bundle
 *
 * src/ itself holds only the entry points (this, engine3d.ts, index.ts, the
 * three widget bundles) and what several bundles or pages share: the
 * contracts, speech.ts, browser-tts.ts, stt.ts. The widget's own parts are
 * under widget/, the continuous mouth's under mouth/.
 *
 * A `destroyed` flag makes mount -> unmount -> mount safe under React
 * StrictMode: the loop and every async callback bail once it is set.
 */
import { mergeTraits, type CharacterTraits } from "./engine/character-mouth";
import { kindProfile, type KindProfile } from "./engine/kind-profile";
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
import { HeadTurn, type OutlineBasis, type TurnStats } from "./engine/head-turn";
import { Motion, type HeadOffset } from "./engine/motion";
import { NeckWarp, neckBlendFor, neckPin, type NeckPin } from "./engine/neck-blend";
import { ClassicMouth } from "./engine/paint-classic-mouth";
import { drawGaze, drawLashes, drawPaintedLids, type EyeSource } from "./engine/paint-eyes";
import { paintMouthSurface } from "./engine/paint-mouth";
import { FacePicture } from "./engine/picture";
import { composeFrame, headMotionAffine, motionTravel, type Layers } from "./engine/render2d";
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
  /**
   * Move a cut-out's head (a picture with a transparent background, no
   * published layers) as its own feathered layer over the still body,
   * instead of the whole picture as one (the default). For comparison
   * only: the layer's feathered band shows as a boundary through the hair,
   * the neck and the shoulders whenever the head moves (render2d.ts).
   * `setCutOutHeadLayer` switches it live. Layered avatars and opaque
   * pictures are unaffected.
   */
  cutOutHeadLayer?: boolean;
  /**
   * How the head moves. "3d", the default for a person's photograph (the
   * rig's render profile, kind-profile.ts: none or human): the face turns
   * in depth inside the mesh, about a pivot between the ears
   * (engine/head-turn.ts), at most 7 degrees of yaw, 5 of pitch and 3 of
   * roll, with a procedural personality (engine/head-personality.ts); the
   * head's rigid motion (the layer, the whole picture, a cut-out's bust)
   * carries a share of it. "2d", the default for a character or an animal
   * (toon@1, animal@1, animal@2): as a rigid layer, shifted and rolled a
   * few pixels (render2d.ts), with nods on the speech's beats. Either may
   * be asked for; `setHeadMotion` switches it live, and the widget's
   * `data-head-motion` sets it.
   */
  headMotion?: HeadMotionMode;
}

/** EngineOptions.headMotion. */
export type HeadMotionMode = "2d" | "3d";

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
  /** The "3d" head motion's turn, fitted to the mesh it was built for, and
   *  its outline's weights, which serve every viewport of this rig. */
  private headTurn: HeadTurn | null = null;
  private headTurnFor: unknown = null;
  private outlineBasis: OutlineBasis | null = null;
  /** A layered avatar's neck warp (neck-blend.ts), for the mesh it was
   *  laid for, and the canvas its layers are drawn on. */
  private neckWarp: NeckWarp | null = null;
  private neckWarpFor: unknown = null;
  private neckScratch: HTMLCanvasElement | null = null;
  /** This frame turns the face in depth (the "3d" motion, not at rest). */
  private turning = false;

  constructor(canvas: HTMLCanvasElement, rig: Rig, texture: HTMLImageElement, opts: EngineOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.rig = rig;
    this.profile = kindProfile(rig);
    this.traits = this.profile.traits;
    this.picture = new FacePicture(canvas, rig, this.profile, texture, (pts) =>
      this.motion.measureBody(pts, canvas.height)
    );
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
      replace: picture.cutOut,
      // Turned in depth, the outline is left unpadded (mesh-warp.ts); a face at
      // rest draws as it always did.
      unpadOutline: this.turning,
    }));
    this.innerRing = validInnerRing(rig);
    this.classicMouth = new ClassicMouth(ctx, this.profile, this.innerRing);
    this.picture.useHeadLayer(opts.cutOutHeadLayer ?? false);
    this.picture.lay(this.scene.zoom ?? 1, this.scene.pan, true);
    this.motion.mode = opts.headMotion ?? this.profile.headMotion;
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
  setLayers(layers: { background?: HTMLImageElement; body: HTMLImageElement; head: HTMLImageElement }): void {
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
   * the head layer (if opted into), and what the picture looks like.
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
    // The neck's scratch canvas is the stage's size: give its pixels back.
    if (this.neckScratch) this.neckScratch.width = this.neckScratch.height = 1;
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

  /**
   * Move a cut-out's head as its own layer (true) or the whole picture as
   * one (false, the default), live: EngineOptions.cutOutHeadLayer, for
   * comparing the two.
   */
  setCutOutHeadLayer(on: boolean): void {
    if (this.destroyed) return;
    this.picture.useHeadLayer(on);
  }

  /**
   * Choose the head motion live (EngineOptions.headMotion): "2d" the rigid
   * layer, "3d" the turn in depth; for a side-by-side, or a page that
   * wants the other one.
   */
  setHeadMotion(mode: HeadMotionMode): void {
    if (this.destroyed || mode === this.motion.mode) return;
    this.motion.mode = mode;
    if (mode === "3d" && this.speech.speaking)
      this.motion.setSpeechCues(this.speech.cues, this.speech.cueTime(performance.now()));
  }

  /** Which head motion is running: EngineOptions.headMotion, else the
   *  rig's profile's. */
  headMotion(): HeadMotionMode {
    return this.motion.mode;
  }

  /** The last "3d" frame's turn: fold counts, the share of the turn the
   *  fold clamp kept, the largest shift. */
  headTurnStats(): Readonly<TurnStats> | null {
    return this.headTurn?.stats ?? null;
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
    if (this.motion.mode === "3d") this.motion.setSpeechCues(this.speech.cues);
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
    if (this.motion.mode === "3d") this.motion.setSpeechCues(this.speech.cues);
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
    if (this.motion.mode === "3d") this.motion.setSpeechCues(this.speech.cues, time);
  }

  /** Re-align the cue clock to a known position in the track (ms). */
  syncCueTime(ms: number): void {
    this.speech.seek(ms, performance.now());
    this.motion.placeBeatWalker(ms);
    if (this.motion.mode === "3d") this.motion.setSpeechCues(this.speech.cues, ms);
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
    const visemeWeights =
      this.pose?.()?.weights ?? (speech.speaking ? this.blendedCueWeights(now) : { ...ZERO_WEIGHTS });
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

    this.motion.headScale = this.tuning.headMotion;
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
  private deformedPoints(turn?: (pts: Point[]) => void, pin?: NeckPin | null): Point[] {
    const picture = this.picture;
    return deformFace({
      turn,
      pin,
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

  /**
   * The "3d" head motion's frame: the rigid motion's share of the turn, and
   * the turn of the face inside the mesh, which makes up the rest. The
   * outline stays with the rigid motion (head-turn.ts), so what the rigid
   * motion does not carry of the head's travel and roll is not seen: a
   * roll, an affine motion of the outline, is the rigid motion's alone.
   * Half the skull's travel and 40% of the roll move a layered avatar's
   * head, which hands the motion over to the body down the neck
   * (neck-blend.ts); a cut-out's bust leans by half the travel and 30% of
   * the roll (render2d.ts applyBustTransform); an opaque photo moves whole,
   * background and all, so a third of the travel and a fifth of the roll
   * (its edge, in the whole framing, tilts by that: at most 0.6 degrees,
   * as today's motion's does).
   */
  private headFrame3d(): { offset: HeadOffset; turn: ((pts: Point[]) => void) | undefined } {
    const picture = this.picture;
    const geom = picture.headGeom;
    if (this.headTurnFor !== picture.mesh) {
      this.headTurnFor = picture.mesh;
      this.headTurn = HeadTurn.build(picture.mesh, this.rig.triangles, this.outlineBasis);
      if (this.headTurn) this.outlineBasis = this.headTurn.basis;
    }
    const turner = this.headTurn;
    const { pose, brow } = this.motion.pose3d(this.tuning.headMotion);
    const still: HeadOffset = { dx: 0, dy: 0, roll: 0, fdx: 0, fdy: 0 };
    if (!turner || !geom) return { offset: still, turn: undefined };
    const layered = !!this.layers;
    const share = layered || picture.cutOut ? 0.5 : 0.35;
    const rollShare = layered ? 0.4 : picture.cutOut ? 0.3 : 0.2;
    const skull = turner.skullShift(pose);
    const offset: HeadOffset = {
      dx: skull.x * share,
      dy: skull.y * share,
      roll: pose.roll * rollShare,
      fdx: 0,
      fdy: 0,
    };
    // The turn takes out the rigid motion's shift (or lean); its roll turns
    // the face and the outline alike (head-turn.ts apply).
    const rigid = headMotionAffine(geom, { ...offset, roll: 0 }, picture.cutOut && !layered);
    const quiet = Math.abs(pose.yaw) + Math.abs(pose.pitch) + brow < 1e-6;
    return {
      offset,
      turn: quiet ? undefined : (pts) => turner.apply(pts, pose, rigid, brow),
    };
  }

  /**
   * A layered avatar's neck this frame (neck-blend.ts): the warp the body
   * and head layers are drawn through and the neck band is placed by, for
   * the head moved by `offset` relative to the body; null for any other
   * picture, and while the head rests on its body.
   */
  private neckFor(offset: HeadOffset): NeckPin | null {
    const picture = this.picture;
    const geom = picture.headGeom;
    if (!this.layers || !geom) return null;
    if (this.neckWarpFor !== picture.mesh) {
      this.neckWarpFor = picture.mesh;
      const blend = neckBlendFor(picture.mesh);
      this.neckWarp = blend ? new NeckWarp(blend, picture.mesh.picture) : null;
    }
    if (!this.neckWarp || (!offset.dx && !offset.dy && !offset.roll)) return null;
    return neckPin(this.neckWarp, headMotionAffine(geom, offset, false));
  }

  private render(): void {
    const ctx = this.ctx;
    const picture = this.picture;
    const travel = motionTravel(!!this.layers, picture.cutOut, this.tuning);
    const head3d = this.motion.mode === "3d" ? this.headFrame3d() : null;
    const headOffset = head3d?.offset ?? this.motion.headOffset(picture.headGeom, travel.head);
    const neck = this.neckFor(headOffset);
    this.turning = !!head3d?.turn;
    const pts = this.deformedPoints(head3d?.turn, neck);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    composeFrame({
      ctx,
      picture: picture.mesh.picture,
      texture: picture.texture,
      layers: this.layers,
      cutOut: picture.cutOut,
      head: picture.headGeom,
      // A cut-out's head layer (opted into) is not used in 3D: the bust
      // leans and the face turns inside the mesh.
      headLayer: head3d ? null : picture.headLayer,
      headOffset,
      bodyLean: this.motion.bodyLean(travel.body),
      neck: neck ? { warp: neck.warp, scratch: (this.neckScratch ??= document.createElement("canvas")) } : null,
      drawMesh: (affine) => this.meshWarp.draw(ctx, pts, affine),
      drawFeatures: () => this.paintFeatures(pts),
    });
    // The scene's background last, still, BEHIND the finished picture
    // (scene.ts).
    this.backdrop.draw(ctx, this.scene.background, picture.cutOut, this.canvas);
  }

  /** Everything painted over the warped mesh, in the head's frame: the
   *  eyes, the lids or the lashes, the mouth, the debug mesh. */
  private paintFeatures(pts: Point[]): void {
    const ctx = this.ctx;
    const { texture, mesh, samples } = this.picture;
    const eyes: EyeSource = { texture, texPoints: mesh.texPoints };
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
