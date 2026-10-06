/**
 * Liveface canvas engine: textured triangle-mesh warp + cue-driven lip-sync.
 *
 * Hard-won implementation notes (do not "simplify" these away):
 * - Triangle warps solve the source->dest affine with CRAMER'S RULE; the
 *   naive derivation is degenerate and draws nothing. |det| < 1e-6 is skipped.
 * - Texture coords map to the TEXTURE's own naturalWidth/naturalHeight (the
 *   thumbnail may be scaled down), never to rig.image_size.
 * - The inner-lip ring is ANGLE-SORTED around its centroid before building
 *   the mouth-cavity clip; raw index order self-intersects and the clip
 *   leaks across the face.
 * - Teeth are anatomically fixed-size and hang from the lips; jawOpen grows
 *   the dark gap, NOT the teeth.
 * - A `destroyed` flag makes mount -> unmount -> mount safe under React
 *   StrictMode.
 */
import {
  CharacterField,
  characterOpening,
  mergeTraits,
  openingPath,
  type CharacterTraits,
} from "./character-mouth";
import { paintCharacter } from "./character-paint";
import { buildLowerFaceRig, type LowerFaceRig } from "./jaw-rig";
import { kindProfile, type KindProfile } from "./kind-profile";
import { padTriangle } from "./seam-pad";
import { IDENTITY, WarpRenderer, buildWarpMesh, rotate, translate, type Affine } from "./warp-gl";
import type { MouthExtension, MouthPose } from "./mouth-extension";
import { BlendWeights, Cue, DEFAULT_TUNING, EngineTuning, Rig, ZERO_WEIGHTS } from "./types";
import { emphasisBeats, utteranceMs } from "./engine/cues";
import { drawDebugMesh } from "./engine/debug";
import { deformFace } from "./engine/deform";
import {
  layOutFace,
  pixelScale,
  placeHead,
  refineMesh,
  validInnerRing,
  type FaceMesh,
  type HeadGeom,
  type Point,
} from "./engine/geometry";
import { LANDMARK_COUNT } from "./engine/landmarks";
import { Motion, type HeadOffset } from "./engine/motion";
import { ClassicMouth } from "./engine/paint-classic-mouth";
import { drawGaze, drawLashes, drawPaintedLids } from "./engine/paint-eyes";
import { cutHeadLayer } from "./engine/render2d";
import { FaceSamples, probeCutOut } from "./engine/sampling";
import { SpeechTrack, articulate, easeTongue } from "./engine/speech";
import { restingFace, type FaceState } from "./engine/state";

export { articulationLead, emphasisBeats, prepareCues, type Beat } from "./engine/cues";
export { hingeShare } from "./engine/deform";
export type { Point } from "./engine/geometry";
export { luma, pickScleraColour, type Sample } from "./engine/sampling";

/** Sway is scaled down when the photo still has its background: moving the
 *  whole picture then reads as a wobbling camera rather than a moving person,
 *  and it drags the photo's own edge into frame. */
const OPAQUE_BACKGROUND_SCALE = 0.3;

export interface EngineOptions {
  debugMesh?: boolean;
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

/** See EngineOptions.warp. */
export type WarpMode = "auto" | "2d";

/** What is behind a cut-out: nothing, a colour, or a picture (cover-fitted
 *  to the canvas). An opaque picture covers it, so it is not drawn then. */
export interface SceneBackground {
  kind: "transparent" | "color" | "image";
  color?: string;
  image_url?: string;
}

/** The scene (the owner's framing editor): zoom 1 is the face view, 0 the
 *  whole picture, up to 1.3 closer in; pan moves the view as fractions of
 *  the canvas; the background sits behind a cut-out. */
export interface Scene {
  zoom?: number;
  pan?: { x: number; y: number };
  background?: SceneBackground | null;
}

export class AvatarEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rig: Rig;
  /** What the rig's line changes in the mouth; today's human renderer
   *  unless the rig names a profile. */
  private readonly profile: KindProfile;
  /** The character mouth (character-mouth.ts), only for a profile that asks
   *  for it: the jaw field, what the picture looks like, the owner's traits
   *  and how high the tongue is now. Null for every classic rig. */
  private field: CharacterField | null = null;
  /** The jaw, chin and cheeks for every mouth driver (jaw-rig.ts), built
   *  from the rest mesh with the framing. */
  private lowerFace: LowerFaceRig | null = null;
  private traits: CharacterTraits;
  private texture: HTMLImageElement;
  /** StrictMode guard: render loop and async callbacks bail once destroyed. */
  private destroyed = false;

  /** The face mesh laid on the canvas (geometry.ts): rebuilt whole when
   *  the viewport or the texture changes. */
  private mesh: FaceMesh;
  /** The inner-lip ring the classic mouth is built on (validInnerRing). */
  private readonly innerRing: number[];
  /** The classic drawn mouth (paint-classic-mouth.ts). */
  private readonly classicMouth: ClassicMouth;

  // Animation state
  /** What the face is doing this frame (state.ts): the tick writes it, the
   *  deformation and the painters read it. */
  private readonly face: FaceState = restingFace();
  /** The speech in flight: cue track, clock, voice (speech.ts). */
  private readonly speech: SpeechTrack;
  /** Blinks, gaze, the head's drift and nods, the body's sway (motion.ts). */
  private readonly motion = new Motion(this.face);
  private mouthExtension?: MouthExtension;
  private readonly pose?: () => MouthPose | null;
  // The head as a movable unit (geometry.ts placeHead): where it sits and
  // how far it may travel, and for a cut-out the head REGION of the photo —
  // hair, ears, skull — cut out once with feathered edges (render2d.ts).
  private headLayer: HTMLCanvasElement | null = null;
  private headGeom: HeadGeom | null = null;
  /** Whether the photo is a cut-out. Decides how far the body may move. */
  private cutOut = false;
  /** What the picture looks like (sampling.ts), read again with every
   *  texture. */
  private readonly samples = new FaceSamples();
  private raf = 0;
  private lastTickAt = 0;

  debugMesh: boolean;
  /** Live animation parameters — mutate freely, applied next frame. */
  tuning: EngineTuning = { ...DEFAULT_TUNING };
  /** The scene: the zoom the viewport is at (1 the face, 0 the whole
   *  picture), the pan, and what is behind a cut-out. */
  private scene: Scene;
  /** The scene's background picture once it has loaded; null until then,
   *  and null for good when it fails (the avatar never waits for it). */
  private backgroundImage: HTMLImageElement | null = null;
  private backgroundUrl: string | null = null;

  // Layered render path (see setLayers). Null means single-photo.
  private layers: {
    background?: HTMLImageElement;
    body: HTMLImageElement;
    head: HTMLImageElement;
  } | null = null;

  // The GPU warp (warp-gl.ts): null where WebGL is unavailable or the page
  // asked for 2D. What it holds is checked against the engine's texture
  // and triangle list by reference each frame, so a new texture or a
  // rebuilt mesh is uploaded once, the frame it first draws.
  private warp: WarpRenderer | null = null;
  private warpMode: WarpMode;
  private warpTextureFor: HTMLImageElement | null = null;
  private warpTextureOk = false;
  private warpMeshFor: unknown = null;


  constructor(canvas: HTMLCanvasElement, rig: Rig, texture: HTMLImageElement, opts: EngineOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.rig = rig;
    this.profile = kindProfile(rig);
    this.traits = this.profile.traits;
    this.texture = texture;
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
    this.loadBackground();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    this.warpMode = opts.warp ?? "auto";
    if (this.warpMode !== "2d") this.warp = WarpRenderer.create(canvas.width, canvas.height);
    this.innerRing = validInnerRing(rig);
    this.classicMouth = new ClassicMouth(ctx, this.profile, this.innerRing);
    this.mesh = this.layOut();
    this.samples.sample(this.texture, this.mesh.texPoints, this.rig, this.profile);
    refineMesh(this.mesh, this.rig, this.texture);
    this.motion.start(performance.now());
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    // Debug handle (last engine wins): lets a console force blinks/visemes.
    (globalThis as { __liveface?: AvatarEngine }).__liveface = this;
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
   * sampled or derived from the texture is redone: the lip/lash colours,
   * the mesh (texPoints, the mouth subdivision), the cut-out probe and the
   * head layer.
   */
  setTexture(texture: HTMLImageElement): void {
    if (this.destroyed) return;
    this.texture = texture;
    // NOTE: read at the texPoints laid out for the texture before this one
    // (rebuildGeometry lays this one out after), so a texture of another
    // size, the widget's full picture after its thumbnail, is sampled at
    // the wrong pixels.
    this.samples.sample(this.texture, this.mesh.texPoints, this.rig, this.profile);
    this.rebuildGeometry();
  }

  /**
   * Lay the picture on the canvas again (the viewport or the texture
   * changed): a new mesh, refined, and everything placed by it.
   */
  private rebuildGeometry(): void {
    this.mesh = this.layOut();
    refineMesh(this.mesh, this.rig, this.texture);
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
    if (moved) this.rebuildGeometry();
    this.loadBackground();
  }

  /** Start loading the scene's background picture, if it changed. */
  private loadBackground(): void {
    const background = this.scene.background;
    const url = background?.kind === "image" && background.image_url ? background.image_url : null;
    if (url === this.backgroundUrl) return;
    this.backgroundUrl = url;
    this.backgroundImage = null;
    if (!url) return;
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (!this.destroyed && this.backgroundUrl === url) this.backgroundImage = img;
      };
      img.onerror = () => undefined; // transparent it stays
      img.src = url;
    } catch {
      // No Image in this environment (tests): transparent.
    }
  }

  /**
   * What is behind a cut-out, drawn first and still: a colour, or a
   * picture cover-fitted to the canvas. An opaque picture covers the whole
   * canvas wherever it reaches, so nothing is drawn for it.
   */
  private drawSceneBackground(): void {
    const background = this.scene.background;
    if (!background || background.kind === "transparent" || !this.cutOut) return;
    const ctx = this.ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    if (background.kind === "color" && background.color) {
      ctx.save();
      ctx.fillStyle = background.color;
      ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
      return;
    }
    const img = this.backgroundImage;
    if (background.kind !== "image" || !img) return;
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const scale = Math.max(cw / iw, ch / ih);
    const w = iw * scale, h = ih * scale;
    ctx.drawImage(img, 0, 0, iw, ih, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  /**
   * The owner's mouth settings for a character mouth (jaw, teeth, tongue),
   * over the profile's own. Ignored by a classic mouth.
   */
  setCharacterTraits(own: Partial<CharacterTraits> | null | undefined): void {
    this.traits = mergeTraits(this.profile.traits, own);
  }

  /**
   * Stop or restart drawing, e.g. when the avatar scrolls out of view.
   *
   * Browsers already stop animation frames in hidden tabs; this covers a
   * visible tab where the canvas is simply off-screen, which otherwise costs
   * a full render every frame for nothing. Time does not jump on resume: the
   * tick clamps its step, so the motion carries on rather than lurching.
   */
  setActive(active: boolean): void {
    if (this.destroyed) return;
    if (!active) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else if (!this.raf) {
      this.raf = requestAnimationFrame(this.loop);
    }
  }

  /**
   * The 478 face landmarks at rest, in canvas pixels. Read-only, for
   * overlays drawn in step with the face (a scan effect, a debug view).
   */
  landmarks(): ReadonlyArray<Readonly<Point>> {
    return this.mesh.basePoints.slice(0, LANDMARK_COUNT);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.speech.destroy();
    this.warp?.destroy();
    this.warp = null;
  }

  /**
   * Choose the warp path live: "2d" for the Canvas 2D triangle loop, "auto"
   * for the GPU wherever it works. For the lab's side-by-side and for a
   * page that must not use WebGL.
   */
  setWarp(mode: WarpMode): void {
    if (this.destroyed || mode === this.warpMode) return;
    this.warpMode = mode;
    if (mode === "2d") {
      this.warp?.destroy();
      this.warp = null;
    } else {
      this.warp = WarpRenderer.create(this.canvas.width, this.canvas.height);
    }
    this.warpTextureFor = null;
    this.warpMeshFor = null;
  }

  /** Which path the next frame takes: "gl" when the GPU warp is ready. */
  warpPath(): "gl" | "2d" {
    return this.glWarp() ? "gl" : "2d";
  }

  // --- Framing -------------------------------------------------------------

  /**
   * Lay the picture on the canvas (geometry.ts layOutFace) and place by it
   * what moves with the framing: the cut-out probe, the body's pivot, the
   * head's rectangle and layer, the character field and the lower face.
   * The mesh comes back unrefined (refineMesh).
   */
  private layOut(): FaceMesh {
    const mesh = layOutFace(this.rig, this.texture, this.canvas, this.scene.zoom ?? 1, this.scene.pan);
    const cutOut = probeCutOut(this.texture);
    if (cutOut !== null) this.cutOut = cutOut;
    this.motion.measureBody(mesh.basePoints, this.canvas.height);
    // The head as a movable unit (geometry.ts placeHead); a cut-out also
    // gets it as its own feathered layer, which moves over transparency.
    this.headGeom = placeHead(mesh.basePoints, mesh.picture);
    this.headLayer = this.headGeom && this.cutOut ? cutHeadLayer(this.texture, this.rig, mesh, this.headGeom) : null;
    this.field = this.profile.mouth === "character" ? new CharacterField(mesh.basePoints) : null;
    this.lowerFace = buildLowerFaceRig(mesh.basePoints);
    return mesh;
  }

  /** Current head displacement in canvas px (motion.ts headOffset). */
  private headOffsets(): HeadOffset {
    // Ghosting: a moved layer over an intact photo leaves a sliver of the
    // original behind it. A cut-out has its head punched out of the base, so
    // it can travel further.
    // Layered heads move at full strength: there is real content behind
    // them, so wider travel reveals pixels instead of tearing them.
    return this.motion.headOffset(this.headGeom, (this.layers || this.cutOut ? 1 : 0.5) * this.tuning.headMotion);
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

  private loop(now: number): void {
    if (this.destroyed) return;
    this.tick(now);
    this.render();
    this.raf = requestAnimationFrame(this.loop);
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

    // The frame's step, clamped: a hidden tab or a stall resumes the motion
    // where it was rather than lurching.
    const dt = Math.min(64, Math.max(4, now - (this.lastTickAt || now - 16.7)));
    this.lastTickAt = now;
    articulate(face.weights, face.targetWeights, dt, this.tuning.smoothness);

    if (this.field) face.tongue = easeTongue(face.tongue, this.pose?.()?.viseme ?? speech.currentViseme(now), dt);

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
  private deformedPoints(_now: number): Point[] {
    return deformFace({
      rig: this.rig,
      mesh: this.mesh,
      innerRing: this.innerRing,
      face: this.face,
      tuning: this.tuning,
      profile: this.profile,
      field: this.field,
      traits: this.traits,
      lowerFace: this.lowerFace,
      mouthExtension: this.mouthExtension,
      speaking: this.speech.speaking,
      energy: this.motion.energy,
    });
  }

  // --- Rendering ---------------------------------------------------------------

  private render(): void {
    const now = performance.now();
    const ctx = this.ctx;
    const pts = this.deformedPoints(now);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // The scene's background first, under everything and still.
    this.drawSceneBackground();

    if (this.layers) {
      this.renderLayered(pts);
      return;
    }

    // Body motion is applied to the finished picture, not to the mesh.
    //
    // That is the whole point: a rigid transform cannot distort a face. The
    // earlier attempt to move the head warped vertices to fake a rotation,
    // which deformed the features instead of turning them. Sway and breathing
    // are things a camera sees a whole subject do, so moving the whole
    // drawing is not an approximation — it is exactly right.
    ctx.save();
    // The same transform is kept as an affine alongside the context's own,
    // for the GPU warp, which draws the mesh through it (drawWarp).
    let affine = this.applyBodyTransform(ctx);

    // --- Head motion ------------------------------------------------------
    //
    // The whole head — hair included — moves as one rigid unit, which is
    // what makes a shift read as a turn. HOW depends on what is behind it.
    // A cut-out has nothing behind its head but transparency: the head is
    // cut out as its own feathered layer, erased from the base and drawn
    // moved, and its edges are the hair's own. A picture with an opaque
    // background has no such edge: a moved copy of the head over the still
    // picture leaves a seam wherever the copy's rectangle meets what it
    // covers, and at the picture's boundary (a scan on white, a portrait
    // on grey) the rotated copy pokes past the edge as a torn, jagged rim.
    // So an opaque picture moves AS ONE, picture and mesh together: there
    // is no second copy, and nothing to seam.
    const head = this.headOffsets();
    const geom = this.headGeom;
    const asOne = !this.cutOut;
    if (asOne && geom) affine = this.applyHeadTransform(ctx, geom, head, affine);

    // Base layer: the whole un-warped photo, through the viewport. Triangle
    // seams and sub-pixel gaps in the warp then reveal original pixels
    // instead of holes, and the hair, shoulders and background are simply
    // there, as far as the canvas reaches.
    this.drawFullFrame(this.texture);

    const layered = !asOne && geom && this.headLayer;
    if (layered) {
      // The head erased from the base first, so the moved layer does not
      // leave a ghost of itself behind.
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(this.headLayer!, geom.x, geom.y);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.save();
    if (layered) {
      affine = this.applyHeadTransform(ctx, geom, head, affine);
      // ADDED back, not laid over: the punch-out left base * (1 - a) where
      // the layer's feathered alpha is a, and the layer brings hair * a.
      // Source-over would attenuate the remainder a second time, by
      // (1 - a) again, and the feather band came out a quarter transparent
      // at rest: a faint rectangle around every cut-out's head, over
      // whatever the page showed behind it. Summed, the two are the base
      // again exactly where nothing moved, and the moved copy elsewhere.
      ctx.globalCompositeOperation = "lighter";
      ctx.drawImage(this.headLayer!, geom.x, geom.y);
      ctx.globalCompositeOperation = "source-over";
      ctx.translate(head.fdx, head.fdy);
      affine = translate(affine, head.fdx, head.fdy);
    }

    this.drawWarp(pts, affine);
    this.paintFeatures(pts);
    ctx.restore();
    ctx.restore();
  }

  /** Draw a whole full-frame image (the photo, or a layer aligned to it)
   *  through the viewport. */
  private drawFullFrame(img: HTMLImageElement): void {
    const pic = this.mesh.picture;
    this.ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, pic.x, pic.y, pic.w, pic.h);
  }

  /**
   * The layered picture: still background, swaying body, moving head.
   *
   * Every layer is real pixels — the body's collar exists under the head,
   * the wall exists behind the hair — so no motion can reveal a hole, and
   * none of the single-photo path's compensations (punch-out, feathered
   * cutout, reduced travel over an attached background) apply. Body sway
   * runs at full strength because the background genuinely stays still,
   * which is exactly what a camera watching a standing person sees.
   */
  private renderLayered(pts: Point[]): void {
    const ctx = this.ctx;
    const L = this.layers!;

    if (L.background) this.drawFullFrame(L.background);

    ctx.save();
    let affine = this.applyBodyTransform(ctx, true);
    this.drawFullFrame(L.body);

    const head = this.headOffsets();
    const geom = this.headGeom;
    ctx.save();
    if (geom) affine = this.applyHeadTransform(ctx, geom, head, affine);
    this.drawFullFrame(L.head);

    this.drawWarp(pts, affine);
    this.paintFeatures(pts);
    ctx.restore();
    ctx.restore();
  }

  /** Everything painted over the warped mesh, in the head's frame: the
   *  eyes, the lids or the lashes, the mouth, the debug mesh. */
  private paintFeatures(pts: Point[]): void {
    const ctx = this.ctx;
    const eyes = { texture: this.texture, texPoints: this.mesh.texPoints };
    drawGaze(ctx, pts, eyes, this.face.gaze);
    if (this.profile.blink === "lid") drawPaintedLids(ctx, pts, eyes, this.face.blink, this.tuning.blink, this.samples);
    else drawLashes(ctx, pts, this.face.blink, this.samples.lashColour);
    this.drawMouthSurface(pts);
    if (this.debugMesh) drawDebugMesh(ctx, pts, this.mesh.triangles, this.innerRing);
  }

  private drawMouthSurface(pts: Point[]): void {
    let painted = false;
    if (this.mouthExtension?.paint) {
      this.ctx.save();
      try {
        painted = this.mouthExtension.paint(this.ctx, {
          points: pts, neutral: this.mesh.basePoints, rig: this.rig, weights: this.face.weights,
          lipColour: this.samples.lipColour,
          skinColour: this.samples.skinColour ?? undefined,
          faceHighlight: this.samples.faceHighlight ?? undefined,
          soft: this.samples.look.soft,
          sharpness: this.samples.faceSharpness ?? undefined,
          pixelScale: pixelScale(this.mesh, this.rig, this.texture),
          viseme: this.pose?.()?.viseme ?? this.speech.currentViseme(performance.now()),
        });
      } finally { this.ctx.restore(); }
    }
    if (!painted) {
      if (this.field && !this.mouthExtension) {
        this.drawCharacterMouth(pts);
        return;
      }
      this.classicMouth.paint({
        pts,
        neutral: this.mesh.basePoints,
        weights: this.face.weights,
        lipColour: this.samples.lipColour,
        skinColour: this.samples.skinColour,
        mouthOpen: this.tuning.mouthOpen,
        teethThreshold: this.tuning.teethThreshold,
        extension: this.mouthExtension,
        viseme: () => this.pose?.()?.viseme ?? this.speech.currentViseme(performance.now()),
      });
    }
  }

  /** The character mouth's opening, read off the moved lips, and painted. */
  private drawCharacterMouth(pts: Point[]): void {
    const opening = characterOpening(pts, this.mesh.basePoints);
    if (!opening) return;
    paintCharacter(this.ctx, {
      opening,
      clip: openingPath(opening, () => new Path2D()),
      weights: this.face.weights,
      look: this.samples.look,
      traits: this.traits,
      tongueRaise: this.face.tongue,
      cavityShade: this.profile.cavityShade,
    });
  }

  /**
   * Tip the whole picture about a pivot below the frame, and lift it to breathe.
   *
   * Scaled right down when the photo still carries its own background: moving
   * the entire image then looks like a shaky camera rather than a person
   * shifting their weight, and it walks the photo's own edge into view. A
   * cut-out has no edge to expose, so it gets the full amount.
   */
  private applyBodyTransform(ctx: CanvasRenderingContext2D, layered = false): Affine {
    const lean = this.motion.bodyLean(
      (layered || this.cutOut ? 1 : OPAQUE_BACKGROUND_SCALE) * this.tuning.bodyMotion
    );
    if (!lean) return IDENTITY;
    const { pivot, angle, rise } = lean;
    ctx.translate(pivot.x, pivot.y);
    ctx.rotate(angle);
    ctx.translate(-pivot.x, -pivot.y - rise);
    // The same three steps, as the affine the GPU warp is given.
    let m = translate(IDENTITY, pivot.x, pivot.y);
    m = rotate(m, angle);
    return translate(m, -pivot.x, -pivot.y - rise);
  }

  /**
   * The head's rigid shift and roll about its pivot, on the context and on
   * the affine alike (the GPU warp draws the mesh through the affine).
   */
  private applyHeadTransform(
    ctx: CanvasRenderingContext2D,
    geom: { pivotX: number; pivotY: number },
    head: { dx: number; dy: number; roll: number },
    affine: Affine
  ): Affine {
    ctx.translate(geom.pivotX + head.dx, geom.pivotY + head.dy);
    ctx.rotate(head.roll);
    ctx.translate(-geom.pivotX, -geom.pivotY);
    let m = translate(affine, geom.pivotX + head.dx, geom.pivotY + head.dy);
    m = rotate(m, head.roll);
    return translate(m, -geom.pivotX, -geom.pivotY);
  }

  /**
   * The warped mesh: on the GPU as one draw when the warp renderer is
   * ready, and in 2D, a clipped drawImage per triangle, otherwise (no
   * WebGL, a lost context, a texture it cannot take, `warp: "2d"`).
   *
   * The GPU canvas is already in canvas pixels (it was drawn through
   * `affine`, the context's own transform), so it is drawn under the
   * identity: the picture is resampled once either way.
   */
  private drawWarp(pts: Point[], affine: Affine): void {
    const warp = this.glWarp();
    if (warp && warp.draw(pts, affine)) {
      // Only the mesh's box is copied: outside it the GPU canvas is clear,
      // so the drawing is the same, and the copy is the one GPU-path cost
      // that grows with the canvas rather than with the mesh. Two pixels
      // of margin for the anti-aliased hull.
      const ctx = this.ctx;
      const box = this.warpBox(pts, affine, 2);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(warp.canvas, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
      ctx.restore();
      return;
    }
    const pads = this.trianglePads();
    let t = 0;
    for (const [a, b, c] of this.mesh.triangles) {
      this.drawWarpedTriangle(pts, a, b, c, pads ? pads[t++] : 0);
    }
  }

  /** The mesh's bounding box on the canvas, through `affine`, grown by
   *  `margin` px and clipped to the canvas; whole pixels. */
  private warpBox(pts: Point[], affine: Affine, margin: number): { x: number; y: number; w: number; h: number } {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      const x = affine.a * p.x + affine.c * p.y + affine.e;
      const y = affine.b * p.x + affine.d * p.y + affine.f;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const cw = this.canvas.width, ch = this.canvas.height;
    const x = Math.max(0, Math.floor(x0 - margin)), y = Math.max(0, Math.floor(y0 - margin));
    const w = Math.min(cw, Math.ceil(x1 + margin)) - x, h = Math.min(ch, Math.ceil(y1 + margin)) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : { x: 0, y: 0, w: cw, h: ch };
  }

  /**
   * The GPU warp, brought up to date with the engine (canvas size, the
   * texture, the mesh), or null when the frame must be drawn in 2D.
   */
  private glWarp(): WarpRenderer | null {
    const warp = this.warp;
    if (!warp || !warp.available) return null;
    warp.resize(this.canvas.width, this.canvas.height);
    if (this.warpTextureFor !== this.texture) {
      this.warpTextureFor = this.texture;
      this.warpTextureOk = warp.setTexture(this.texture);
      // The mesh's texture coordinates are over this texture's size.
      this.warpMeshFor = null;
    }
    if (!this.warpTextureOk) return null;
    if (this.warpMeshFor !== this.mesh.triangles) {
      this.warpMeshFor = this.mesh.triangles;
      warp.setMesh(buildWarpMesh(this.mesh.texPoints, this.mesh.triangles, this.texture.naturalWidth, this.texture.naturalHeight));
    }
    return warp;
  }

  private padsFor: unknown = null;
  private pads: Float32Array | null = null;

  /**
   * Each triangle's overlap with its neighbours, px. Worked out once per
   * mesh. A pixel everywhere for a character profile and for any flat
   * picture, whose drawn lines thread through every seam; for a photograph,
   * a pixel wherever the lower-face rig can move the mesh over the still
   * picture (the jaw, the chin, the cheeks, the neck band: the lit neck
   * showed through the seams of the dropped chin as a faint lattice), and
   * none about the eyes and forehead, which draw exactly as they always
   * did. Half a pixel where the lips' own drawn line crosses the mesh.
   */
  private trianglePads(): Float32Array | null {
    if (this.padsFor !== this.mesh.triangles || !this.pads) {
      this.padsFor = this.mesh.triangles;
      const everywhere = !!this.field || this.samples.look.flat;
      const rig = this.lowerFace;
      const moves = (i: number) =>
        i >= 478 || (!!rig && (rig.jaw[i] > 0 || rig.weight[i] > 0 || rig.cheek[i] > 0));
      this.pads = Float32Array.from(this.mesh.triangles, ([a, b, c]) =>
        this.touchesMouth(a, b, c) ? 0.45 : everywhere || moves(a) || moves(b) || moves(c) ? 1 : 0
      );
    }
    return this.pads;
  }

  private mouthSet: Set<number> | null = null;

  /** Does a triangle touch the lips (the rig's mouth points, or a vertex the
   *  mouth subdivision added)? */
  private touchesMouth(a: number, b: number, c: number): boolean {
    if (!this.mouthSet) this.mouthSet = new Set(this.rig.mouth_indices ?? []);
    const set = this.mouthSet;
    const mouthy = (i: number): boolean => {
      if (i < 478) return set.has(i);
      const parents = this.mesh.derivedParents[i - 478];
      return !!parents && (set.has(parents[0]) || set.has(parents[1]));
    };
    return mouthy(a) || mouthy(b) || mouthy(c);
  }

  /**
   * Draw one texture triangle warped to its deformed destination.
   * Affine solved with Cramer's rule; degenerate triangles are skipped.
   */
  private drawWarpedTriangle(pts: Point[], i0: number, i1: number, i2: number, pad = 0): void {
    const ctx = this.ctx;
    const s0 = this.mesh.texPoints[i0], s1 = this.mesh.texPoints[i1], s2 = this.mesh.texPoints[i2];
    const d0 = pts[i0], d1 = pts[i1], d2 = pts[i2];

    const det =
      s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
    if (Math.abs(det) < 1e-6) return;

    const a =
      (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / det;
    const c =
      (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / det;
    const e =
      (d0.x * (s1.x * s2.y - s2.x * s1.y) +
        d1.x * (s2.x * s0.y - s0.x * s2.y) +
        d2.x * (s0.x * s1.y - s1.x * s0.y)) /
      det;
    const b =
      (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / det;
    const d =
      (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / det;
    const f =
      (d0.y * (s1.x * s2.y - s2.x * s1.y) +
        d1.y * (s2.x * s0.y - s0.x * s2.y) +
        d2.y * (s0.x * s1.y - s1.x * s0.y)) /
      det;

    ctx.save();
    ctx.beginPath();
    // Inflate the clip triangle to hide the seams between triangles: a
    // little in proportion on every triangle, plus `pad` px of edge offset
    // where the mesh moves over the still picture (seam-pad.ts). Less where
    // a thin drawn line crosses the triangles, as the lips do: a wide
    // overlap would redraw a pixel of it from the wrong triangle.
    const [g0, g1, g2] = padTriangle(d0, d1, d2, pad);
    ctx.moveTo(g0.x, g0.y);
    ctx.lineTo(g1.x, g1.y);
    ctx.lineTo(g2.x, g2.y);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(this.texture, 0, 0);
    ctx.restore();
  }
}
