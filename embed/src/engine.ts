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
 *   engine/jaw-rig.ts              the lower face as one rig: jaw, chin, cheeks, and
 *   engine/neck-band.ts              the neck band below the jaw line
 *   engine/head-field.ts           the head beyond the face: the hair, the ears, laid
 *   engine/head-extent.ts            as far as the picture says the head reaches
 *   engine/head-layer.ts           a cut-out's head cut out as its own layer (opt-in)
 *   engine/kind-profile.ts         what a line of faces (human, toon, animal) changes
 *   engine/sampling.ts             what the picture looks like
 *   engine/face-light.ts           its brightest skin, the teeth's ceiling
 *   engine/face-sharpness.ts       how sharp its edges are
 * Time
 *   engine/animation.ts            the face, a step at a time: the mouth, the tongue, the motion
 *   engine/cues.ts                 the cue track, read
 *   engine/voice.ts                the voice: cue track, clock, audio (the 3D engine's too)
 *   engine/media-clock.ts          the audio element's own position, as the cue clock
 *   engine/speech.ts               the speech in flight, the articulation
 *   engine/motion.ts               blinks, gaze, the head and the body, from
 *   engine/blink.ts                  when to blink
 *   engine/headmotion.ts             where the head is going (the rigid "2d" motion)
 *   engine/head-personality.ts       where it is turning (the "3d" motion)
 *   engine/bodymotion.ts             the sway and the breath
 *   engine/expression-mixer.ts     the expressions over time (expression-table.ts the data)
 *   engine/state.ts                the face state those write
 *   engine/frame-loop.ts           the frame loop (the 3D engine's too)
 * The frame
 *   engine/head-placement.ts       where the head is: its rigid motion, its turn, the neck
 *   engine/deform.ts               every vertex, this frame, with
 *   engine/expression-rig.ts         the expressions laid on the face, then
 *   engine/head-turn.ts              the head's turn in depth, from
 *   engine/head-depth.ts               the depth it is given (canonical-face.ts, fitted)
 *   engine/head-camera.ts              the turn about the pivot, through the camera
 *   engine/head-outline.ts             the outline held, and the weights that hold it
 *   engine/head-field-turn.ts          the head's field turned with the face
 *   engine/head-fold.ts                the clamp that folds no triangle
 *   engine/neck-blend.ts             a layered avatar's neck, from head to body
 *   engine/render2d.ts             the frame composed: picture, body, head
 *   engine/affine.ts                 the transforms it composes, as the context does
 *   engine/mesh-warp.ts            the warped mesh, on the GPU or in 2D, with
 *   engine/warp-gl.ts                the GPU path, and
 *   engine/warp-mesh.ts                its static mesh
 *   engine/seam-pad.ts               the overlap that hides the seams between triangles
 *   engine/paint-features.ts       what is painted over the mesh:
 *   engine/paint-eyes.ts             gaze, lashes, and
 *   engine/blink-lid.ts                the painted lids
 *   engine/paint-mouth.ts            which mouth paints the mouth, where:
 *   engine/mouth-pose.ts               the mouth's frame while the head turns in depth
 *   engine/paint-classic-mouth.ts      the drawn mouth and its teeth, in
 *   engine/mouth-aperture.ts           the aperture the lips part to
 *   engine/character-mouth.ts          a character's or an animal's mouth, and
 *   engine/character-paint.ts          its painting
 *   engine/scene.ts                the scene, the backdrop of a cut-out
 *   engine/debug.ts                the debug mesh overlay
 *   engine/debug-handle.ts         the console handle, when a page asks for it
 *   engine/options.ts              what a page may ask of the engine (EngineOptions)
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
import { defaultHeadMotion, expressionGains, kindProfile, type KindProfile } from "./engine/kind-profile";
import type { MouthExtension } from "./mouth-extension";
import { DEFAULT_TUNING, type Cue, type EngineTuning, type Rig } from "./types";
import type { Affine } from "./engine/affine";
import { FaceAnimation } from "./engine/animation";
import { NO_DEBUG_HANDLE, exposeDebugHandle } from "./engine/debug-handle";
import { deformFace, type FrameVertices } from "./engine/deform";
import type { ExpressionCue, ExpressionState, ExpressionTiming } from "./engine/expression-mixer";
import { ExpressionPictureLayer } from "./engine/expression-overlay";
import { loadImage, loadPictures, type ExpressionPictureSource, type PictureName } from "./engine/expression-pictures";
import { ExpressionRigs } from "./engine/expression-rig";
import type { ExpressionName } from "./engine/expression-table";
import { FrameLoop } from "./engine/frame-loop";
import { validInnerRing, type Point } from "./engine/geometry";
import { HeadPlacement } from "./engine/head-placement";
import type { TurnStats } from "./engine/head-turn";
import { LANDMARK_COUNT } from "./engine/landmarks";
import { MeshWarp, type WarpMode } from "./engine/mesh-warp";
import { Motion } from "./engine/motion";
import type { NeckPin } from "./engine/neck-blend";
import type { EngineOptions, HeadMotionMode } from "./engine/options";
import { ClassicMouth } from "./engine/paint-classic-mouth";
import { paintFeatures } from "./engine/paint-features";
import { FacePicture } from "./engine/picture";
import { composeFrame, motionTravel, type Layers } from "./engine/render2d";
import { Backdrop, nextScene, startingScene, type Scene } from "./engine/scene";
import { SpeechTrack } from "./engine/speech";
import { restingFace, type FaceState } from "./engine/state";

export { articulationLead, emphasisBeats, prepareCues, type Beat } from "./engine/cues";
export { hingeShare } from "./engine/deform";
export type { Point } from "./engine/geometry";
export type { WarpMode } from "./engine/mesh-warp";
export type { EngineOptions, HeadMotionMode } from "./engine/options";
export type { Scene, SceneBackground } from "./engine/scene";

export class AvatarEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly rig: Rig;
  /** What the rig's line changes in the mouth; today's human renderer
   *  unless the rig names a profile. */
  private readonly profile: KindProfile;
  /** StrictMode guard: async callbacks bail once destroyed. */
  private destroyed = false;
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
  /** The face a step at a time, as the speech goes (animation.ts). */
  private readonly animation: FaceAnimation;
  /** The expressions laid on the mesh now, built when first needed. */
  private readonly expressionRigs: ExpressionRigs;
  /** The AI expression pictures, once loaded (expression-overlay.ts); null
   *  for an avatar without any, or while they load. */
  private pictures: ExpressionPictureLayer | null = null;
  private picturesLoad: AbortController | null = null;
  /** A mouth renderer that moves and paints the mouth instead (mouth/). */
  private mouthExtension?: MouthExtension;
  private readonly frameLoop: FrameLoop;

  // --- Drawing -------------------------------------------------------------

  /** Where the head is this frame (head-placement.ts). */
  private readonly placement: HeadPlacement;
  /** The warped mesh, on the GPU or in 2D (mesh-warp.ts). */
  private readonly meshWarp: MeshWarp;
  /** The classic drawn mouth (paint-classic-mouth.ts). */
  private readonly classicMouth: ClassicMouth;
  /** The frame's vertices (deform.ts), the engine's own from frame to
   *  frame: what a frame draws, and hands the painters and a mouth
   *  extension, is valid for that frame only (mouth-extension.ts). */
  private readonly vertices: FrameVertices = { landmarks: [], all: [] };
  /** What composing a frame calls back (render2d.ts), made once rather
   *  than every frame: the mesh drawn through `affine`, then the features
   *  over it (paint-features.ts), the sound being made read when asked. */
  private readonly drawMesh = (affine: Affine) => {
    this.meshAffine = affine;
    this.meshWarp.draw(this.ctx, this.vertices.all, affine);
    this.pictures?.draw(
      this.ctx,
      this.vertices.all,
      affine,
      this.picture.mesh,
      this.face.expression,
      this.tuning.expression,
      performance.now()
    );
  };
  /** The head's transform the mesh was drawn through this frame (the
   *  silent smile's mouth is drawn through it after the features). */
  private meshAffine: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  private readonly drawFeatures = () => {
    this.paintFeatures();
    this.pictures?.draw(
      this.ctx,
      this.vertices.all,
      this.meshAffine,
      this.picture.mesh,
      this.face.expression,
      this.tuning.expression,
      performance.now(),
      "mouth"
    );
  };
  private readonly paintFeatures = () =>
    paintFeatures({
      ctx: this.ctx,
      pts: this.vertices.all,
      picture: this.picture,
      rig: this.rig,
      face: this.face,
      tuning: this.tuning,
      profile: this.profile,
      traits: this.traits,
      extension: this.mouthExtension,
      classicMouth: this.classicMouth,
      viseme: this.viseme,
      debugRing: this.debugMesh ? this.innerRing : null,
      expressionRig: this.expressionRigs.built,
      cueMix: this.pictures?.withoutPictures(this.face.expression, performance.now()),
      posed: this.placement.posedMouth(this.picture.mesh.basePoints),
    });
  private readonly viseme = () => this.animation.visemeNow(performance.now());

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
    this.animation = new FaceAnimation(this.speech, this.motion, this.face, rig.visemes, opts.pose);
    this.mouthExtension = opts.mouthExtension;
    this.debugMesh = opts.debugMesh ?? false;
    this.scene = startingScene(opts.scene, opts.zoom, opts.fullPhoto);
    this.backdrop.load(this.scene.background);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const picture = this.picture;
    const placement = (this.placement = new HeadPlacement(rig.triangles));
    this.meshWarp = new MeshWarp(canvas, opts.warp ?? "auto", rig.mouth_indices, () =>
      picture.warpSource(placement.turning)
    );
    this.innerRing = validInnerRing(rig);
    const gains = expressionGains(this.profile, opts.faceType);
    this.expressionRigs = new ExpressionRigs(rig.triangles, gains);
    this.animation.expressionJaw = gains.jaw;
    this.animation.expressions.setIdle(opts.idleExpressions ?? false);
    this.classicMouth = new ClassicMouth(ctx, this.profile, this.innerRing);
    this.motion.mode = opts.headMotion ?? defaultHeadMotion(this.profile, opts.faceType);
    this.picture.useHeadLayer(opts.cutOutHeadLayer ?? false);
    // The head's field (the hair and the head's outline turning with the
    // face) is laid for the turn in depth only.
    this.picture.useHeadField(this.motion.mode === "3d");
    this.picture.lay(this.scene.zoom ?? 1, this.scene.pan, true);
    this.motion.start(performance.now());
    this.frameLoop = new FrameLoop((now) => {
      this.tick(now);
      this.render();
    });
    this.releaseDebugHandle = opts.debug ? exposeDebugHandle("__liveface", this) : NO_DEBUG_HANDLE;
  }

  /**
   * Switch to the layered render path: full-frame images aligned to the
   * photo's pixels, a background (none for a cut-out), the body and the
   * head. The head moves over the body's own pixels and the body sways over
   * a still background, so nothing is revealed that does not exist.
   */
  setLayers(layers: { background?: HTMLImageElement; body: HTMLImageElement; head: HTMLImageElement }): void {
    if (this.destroyed) return;
    this.layers = layers;
    // Where the head's field may reach: never past what the layers cover.
    this.picture.setLayers(layers);
  }

  /**
   * Swap in a sharper copy of the same photo, mid-flight: the widget boots
   * on the 256px thumbnail and upgrades when the full picture lands.
   * Everything read from the texture is read again, as if it had been the
   * first (picture.ts lay).
   */
  setTexture(texture: HTMLImageElement): void {
    if (this.destroyed) return;
    this.picture.texture = texture;
    this.picture.lay(this.scene.zoom ?? 1, this.scene.pan, true);
  }

  /**
   * Change the scene live: the zoom and the pan move the viewport, the
   * background swaps what is behind a cut-out. Its picture loads on the
   * side; one that fails leaves the scene transparent, never the avatar.
   */
  setScene(scene: Scene | null | undefined): void {
    if (this.destroyed) return;
    const { scene: next, moved } = nextScene(this.scene, scene);
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

  /** Stop or restart drawing, e.g. when the avatar scrolls out of view
   *  (frame-loop.ts); the motion carries on from where it was. */
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
    this.picturesLoad?.abort();
    this.pictures?.destroy();
    this.frameLoop.stop();
    this.speech.destroy();
    this.meshWarp.destroy();
    this.placement.destroy();
    this.releaseDebugHandle();
  }

  /** Choose the warp path live: "2d" the Canvas 2D triangle loop, "auto"
   *  the GPU wherever it works (a side-by-side, a page without WebGL). */
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
    this.picture.useHeadField(mode === "3d");
    if (mode === "3d" && this.speech.speaking)
      this.motion.setSpeechCues(this.speech.cues, this.speech.cueTime(performance.now()));
  }

  /** Which head motion is running: EngineOptions.headMotion, else the
   *  face type's, else the rig's profile's (defaultHeadMotion). */
  headMotion(): HeadMotionMode {
    return this.motion.mode;
  }

  /** The last "3d" frame's turn: fold counts, the share of the turn the
   *  fold clamp kept, the largest shift. */
  headTurnStats(): Readonly<TurnStats> | null {
    return this.placement.stats();
  }

  // --- Expressions (docs/emotions.md) -----------------------------------------
  /** Show `name` at `intensity` (0..1) on `timing`, over the speech; "neutral" releases. */
  setExpression(name: ExpressionName, intensity = 1, timing: ExpressionTiming = {}): void {
    this.animation.expressions.set(name, intensity, timing, performance.now(), "api");
  }

  /** The expressions now: the one asked for, how far in, every weight. */
  get expression(): ExpressionState {
    return this.animation.expressions.state();
  }

  /** The idle micro-expressions on or off (EngineOptions.idleExpressions). */
  setIdleExpressions(on: boolean): void {
    this.animation.expressions.setIdle(on);
  }

  /**
   * The avatar's AI expression pictures (docs/emotions.md, "AI expression
   * pictures"): the manifest and each picture, presigned, as the published
   * snapshot (or the dashboard's draft) names them; null for none. Loaded
   * on the side: the animated expressions play until they are in, then the
   * pictures come in over ARRIVE_MS. A set that cannot be loaded leaves the
   * animated ones. Resolves when loaded (or given up).
   */
  async setExpressionPictures(source: ExpressionPictureSource | null): Promise<void> {
    this.picturesLoad?.abort();
    this.picturesLoad = null;
    this.pictures?.destroy();
    this.pictures = null;
    if (!source || this.destroyed) return;
    const load = (this.picturesLoad = new AbortController());
    try {
      const { base, pictures } = await loadPictures(source, loadImage, fetch, load.signal);
      if (this.destroyed || load.signal.aborted || !pictures.length) return;
      this.pictures = new ExpressionPictureLayer(pictures, base, performance.now(), this.meshWarp.renderer !== null);
    } catch {
      // The animated expressions stay: a picture set is an improvement,
      // never a requirement.
    }
  }

  /** The expressions an AI picture shows now (empty without any). */
  expressionPictures(): PictureName[] {
    return this.pictures?.names ?? [];
  }

  /** Whether the idle micro-expressions are on (off unless asked for). */
  idleExpressions(): boolean {
    return this.animation.expressions.idleOn;
  }

  // --- Public speech API -----------------------------------------------------

  /**
   * Play base64 audio with a viseme cue track; onEnd runs when it ends, or
   * is stopped. Without a `cueClock` (every page but the lab) cue time is
   * the audio element's own position (media-clock.ts): the mouth waits for
   * the voice however long it takes to start, and rests while it pauses.
   */
  playAudio(audioB64: string, mime: string, cues: Cue[], onEnd?: () => void, expressions?: ExpressionCue[]): void {
    const audio = this.speech.load(audioB64, mime, onEnd ?? null);
    this.animation.begin(performance.now(), cues, expressions);
    this.speech.play(audio, cues.length < 4);
  }

  /** Drive lip-sync from an externally played voice (e.g. speechSynthesis):
   * cues only, no audio element; `expressions` on the same clock. */
  playCues(cues: Cue[], expressions?: ExpressionCue[]): void {
    this.speech.stopAudio();
    const now = performance.now();
    this.animation.begin(now, cues, expressions);
    this.speech.startClock(now);
  }

  /** Swap the mouth renderer on a live engine (null: the classic mouth).
   *  Progressive like setLayers: the face animates while the mouth bundle
   *  and its assets are on their way. */
  setMouthExtension(extension: MouthExtension | null): void {
    this.mouthExtension = extension ?? undefined;
  }

  /** Replace a growing external cue track without restarting articulation:
   *  the streaming extension's look-ahead, appended without restarting the
   *  body's motion, the articulation smoother or the speech clock. */
  updateCueTrack(cues: Cue[]): void {
    const time = this.speech.cueTime(performance.now());
    this.speech.replaceCues(cues);
    this.animation.retrack(time);
  }

  /** The speech's expression track moved in time (the same cues, in the
   *  same order): a stream that learnt how long its speech is. */
  retimeExpressions(track: ExpressionCue[]): void {
    this.animation.expressions.retime(track);
  }

  /** Re-align the cue clock to a known position in the track (ms). */
  syncCueTime(ms: number): void {
    this.speech.seek(ms, performance.now());
    this.animation.resync(ms);
  }

  stopSpeech(): void {
    this.speech.stop();
    this.animation.end(performance.now(), true);
  }

  isSpeaking(): boolean {
    return this.speech.speaking;
  }

  /** The voice ended on its own: as stopSpeech, then the caller's onEnd. */
  private finishSpeech(): void {
    const onEnd = this.speech.finish();
    this.animation.end(performance.now());
    if (onEnd && !this.destroyed) onEnd();
  }

  // --- The frame ---------------------------------------------------------------

  /** One animation step at frame time `now` (animation.ts); no drawing. */
  private tick(now: number): void {
    this.animation.step(now, this.tuning, !!this.picture.field);
    if (this.pictures) {
      const t = this.face.targetWeights;
      const articulation = Math.max(
        t.jawOpen,
        t.mouthFunnel,
        t.mouthPucker,
        this.speech.speaking ? 0.07 * t.mouthClose : 0
      );
      this.pictures.smileLevel = this.pictures.smile.step(now, articulation);
    }
  }

  /** Every mesh vertex this frame (deform.ts): into `into`, the frame's
   *  own; without it (the seam's callers, which keep what they read), new
   *  vertices. */
  private deformedPoints(
    turn?: (pts: Point[]) => void,
    pin?: NeckPin | null,
    head?: (pts: Point[]) => void,
    into?: FrameVertices
  ): Point[] {
    const picture = this.picture;
    return deformFace(
      {
        turn,
        pin,
        head,
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
        expression: this.expressionRigs.get(picture.mesh, picture.texture, this.animation.expressions.active()),
        pictures: this.pictures ? { layer: this.pictures, now: performance.now() } : null,
      },
      into
    );
  }

  private render(): void {
    const ctx = this.ctx;
    const picture = this.picture;
    const travel = motionTravel(!!this.layers, picture.cutOut, this.tuning);
    const head = this.placement.place(picture, this.motion, !!this.layers, this.tuning.headMotion, travel.head);
    this.deformedPoints(head.turn, head.neck, head.head, this.vertices);
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
      headLayer: this.motion.mode === "3d" ? null : picture.headLayer,
      headOffset: head.offset,
      bodyLean: this.motion.bodyLean(travel.body),
      neck: head.neck ? { warp: head.neck.warp, scratch: this.placement.neckCanvas() } : null,
      drawMesh: this.drawMesh,
      drawFeatures: this.drawFeatures,
    });
    // The scene's background last, still, BEHIND the finished picture
    // (scene.ts).
    this.backdrop.draw(ctx, this.scene.background, picture.cutOut, this.canvas);
  }
}
