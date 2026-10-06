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
import { blinkEase } from "./blink";
import { lidAmount, paintLid, type Blit } from "./blink-lid";
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
import { centralMouthAnchors } from "./mouth-extension";
import { BlendWeights, Cue, DEFAULT_TUNING, EngineTuning, Rig, ZERO_WEIGHTS } from "./types";
import { emphasisBeats, utteranceMs } from "./engine/cues";
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
import { EYE_CORNERS, IRISES, LANDMARK_COUNT, LOWER_LIDS, UPPER_LIDS, eyeShape } from "./engine/landmarks";
import { Motion, type HeadOffset } from "./engine/motion";
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

/**
 * Smooth closed curve through an ordered loop of points (Catmull-Rom
 * converted to cubic beziers). Straight segments between landmarks make a
 * mouth outline look faceted; this keeps it continuous.
 */
function smoothClosedPath(points: { x: number; y: number }[]): Path2D {
  const path = new Path2D();
  const n = points.length;
  if (n < 3) return path;
  path.moveTo(points[0].x, points[0].y);
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    path.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x,
      p2.y
    );
  }
  path.closePath();
  return path;
}

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

  /**
   * Copies of the picture's own pixels for a painted lid: a canvas rectangle
   * of the face as drawn, from the texture the face is drawn from. The eye
   * stays where it was drawn (the mesh does not move it for a lid blink), so
   * canvas and texture differ by a scale and an offset read off its corners.
   */
  /** A texture point of an eye, in the canvas the eye is drawn in. */
  private fromTexture(e: number, pts: Point[], t: Point): Point {
    const [c0, c1] = EYE_CORNERS[e];
    const a = pts[c0], b = pts[c1], ta = this.mesh.texPoints[c0], tb = this.mesh.texPoints[c1];
    if (!a || !b || !ta || !tb) return t;
    const k = Math.hypot(tb.x - ta.x, tb.y - ta.y) / Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-6);
    return { x: a.x + (t.x - ta.x) / k, y: a.y + (t.y - ta.y) / k };
  }

  private lidBlit(e: number, pts: Point[]): Blit | null {
    const [c0, c1] = EYE_CORNERS[e];
    const a = pts[c0], b = pts[c1], ta = this.mesh.texPoints[c0], tb = this.mesh.texPoints[c1];
    if (!a || !b || !ta || !tb) return null;
    const k = Math.hypot(tb.x - ta.x, tb.y - ta.y) / Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-6);
    return (c, dst, src) => {
      if (dst.w < 1 || dst.h < 1 || src.w < 1 || src.h < 1) return;
      c.drawImage(
        this.texture,
        ta.x + (src.x - a.x) * k, ta.y + (src.y - a.y) * k, src.w * k, src.h * k,
        dst.x, dst.y, dst.w, dst.h
      );
    };
  }

  /** The painted lid of a profile that blinks that way. */
  private drawLids(pts: Point[]): void {
    if (this.profile.blink !== "lid" || this.face.blink <= 0 || this.tuning.blink <= 0) return;
    const amount = lidAmount(blinkEase(this.face.blink));
    const flat = this.samples.look.flat;
    for (let e = 0; e < 2; e++) {
      const shape = eyeShape(pts, e);
      const outline = this.samples.lidExtent[e]
        ? this.samples.lidExtent[e]!.map((q) => this.fromTexture(e, pts, q))
        : null;
      const blit = flat || !this.samples.lidCloneOk[e] ? null : this.lidBlit(e, pts);
      paintLid(this.ctx, shape, amount, this.samples.lidTone[e], this.samples.lashRgb[e], flat, blit, outline);
    }
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

    this.drawEyes(pts);
    this.drawLids(pts);
    this.drawLashes(pts);
    this.drawMouthSurface(pts);

    if (this.debugMesh) this.drawDebugMesh(pts);
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
    this.drawEyes(pts);
    this.drawLids(pts);
    this.drawLashes(pts);
    this.drawMouthSurface(pts);
    if (this.debugMesh) this.drawDebugMesh(pts);
    ctx.restore();
    ctx.restore();
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
      if (this.profile.contactLine) this.drawLipContactLine(pts);
      this.drawMouthInterior(pts);
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

  /**
   * A lash line riding the closing lid.
   *
   * The mesh alone moves the photographed lashes down with the lid, but as
   * the eye compresses they thin out and lose definition just when the eye
   * most needs an edge. This lays this face's OWN lash colour along the lid's
   * leading edge — sampled, never assumed black, because a fair or stylized
   * face can have brown, auburn or near-white lashes and a black line on
   * those looks pasted on.
   */
  private drawLashes(pts: Point[]): void {
    if (this.face.blink <= 0 || this.profile.blink === "lid") return;
    const phase = this.face.blink;
    const amount =
      phase < 0.4
        ? Math.sin((phase / 0.4) * (Math.PI / 2))
        : Math.cos(((phase - 0.4) / 0.6) * (Math.PI / 2));
    if (amount <= 0.02) return;
    const ctx = this.ctx;
    for (let e = 0; e < 2; e++) {
      const lid = UPPER_LIDS[e]
        .map((i) => pts[i])
        .filter(Boolean)
        .slice()
        .sort((a, b) => a.x - b.x);
      if (lid.length < 3) continue;
      const width = Math.max(...lid.map((p) => p.x)) - Math.min(...lid.map((p) => p.x));
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(lid[0].x, lid[0].y);
      // Through the lid points as a smooth curve, so the line is an arc
      // rather than a chain of segments.
      for (let i = 1; i < lid.length - 1; i++) {
        const mx = (lid[i].x + lid[i + 1].x) / 2;
        const my = (lid[i].y + lid[i + 1].y) / 2;
        ctx.quadraticCurveTo(lid[i].x, lid[i].y, mx, my);
      }
      ctx.lineTo(lid[lid.length - 1].x, lid[lid.length - 1].y);
      ctx.strokeStyle = this.samples.lashColour[e];
      ctx.globalAlpha = amount * 0.85;
      ctx.lineWidth = Math.max(1, width * 0.022);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * Gaze, by sliding the photograph's own eye inside the lids.
   *
   * The predecessor of this method re-stamped an extracted iris disc, and
   * every version broke on some real avatar: a 10-texture-px iris upscaled
   * into a flat grey disc, and painted eyes got their catchlight stamped
   * twice. The rule that survives arbitrary uploads is: never invent eye
   * pixels.
   *
   * So nothing is synthesised here. The texture region around the iris —
   * iris, catchlight, surrounding sclera, whatever the artist drew — is
   * redrawn as one piece, offset by the gaze, clipped to the intersection
   * of TWO detectors: the eye opening built from the deformed lid points,
   * and a circle around MediaPipe's iris ring. The circle is what makes
   * this survive painted eyes: the clip-vs-original seam lands in sclera
   * (white meeting white) instead of on the eyeliner and lashes, where the
   * lid-polygon-only version doubled the lash line. One copy, so there is
   * exactly one iris and one catchlight; the lid clip follows blinks; the
   * shift is capped well inside the circle so the iris never crosses it.
   */
  private drawEyes(pts: Point[]): void {
    const gx = Math.max(-0.6, Math.min(0.6, this.face.gaze.x));
    const gy = Math.max(-0.5, Math.min(0.5, this.face.gaze.y));
    if (Math.abs(gx) < 0.02 && Math.abs(gy) < 0.02) return;

    // Shift scale is capped against the interocular distance, not just the
    // eye's own width: stylised faces (anime) have eyes near half the face
    // wide, and an eye-width-proportional shift slides those giant irises
    // several px — enough to tear against the lashes at the clip boundary.
    const eL0 = pts[EYE_CORNERS[0][0]], eL1 = pts[EYE_CORNERS[0][1]];
    const eR0 = pts[EYE_CORNERS[1][0]], eR1 = pts[EYE_CORNERS[1][1]];
    const interOc =
      eL0 && eL1 && eR0 && eR1
        ? Math.hypot(
            (eR0.x + eR1.x - eL0.x - eL1.x) / 2,
            (eR0.y + eR1.y - eL0.y - eL1.y) / 2
          )
        : 0;

    const ctx = this.ctx;
    for (let e = 0; e < 2; e++) {
      const [c0, c1] = EYE_CORNERS[e];
      const a = pts[c0], b = pts[c1];
      const ta = this.mesh.texPoints[c0], tb = this.mesh.texPoints[c1];
      if (!a || !b || !ta || !tb) continue;
      const eyeW = Math.hypot(b.x - a.x, b.y - a.y);
      if (eyeW < 3) continue;

      // The pupil detector: iris center and radius from the ring points.
      const [ic, ring] = IRISES[e];
      const c = pts[ic], tc = this.mesh.texPoints[ic];
      if (!c || !tc) continue;
      let r = 0;
      for (const i of ring) {
        const q = pts[i];
        if (!q) { r = 0; break; }
        r += Math.hypot(q.x - c.x, q.y - c.y);
      }
      r /= 4;
      if (r < 2) continue;

      // The opening: corner, upper lid, corner, lower lid back. Built from
      // the DEFORMED points, so a blink shrinks the clip and mid-blink the
      // patch only paints below the descended lid.
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      for (const i of UPPER_LIDS[e]) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.lineTo(b.x, b.y);
      for (let j = LOWER_LIDS[e].length - 1; j >= 0; j--) {
        const q = pts[LOWER_LIDS[e][j]];
        ctx.lineTo(q.x, q.y);
      }
      ctx.closePath();
      ctx.clip();
      // ∩ the iris circle, generous enough to hold the shifted iris plus a
      // sclera margin where the seam can hide.
      const R = r * 1.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
      ctx.clip();

      // Shift, capped twice: within the circle (so the iris rim never
      // reaches the clip edge) and against the interocular distance (so a
      // giant stylised iris still moves a believable few pixels).
      const capX = Math.min(r * 0.35, interOc * 0.05);
      const capY = Math.min(r * 0.25, interOc * 0.035);
      const sx = gx * capX, sy = gy * capY;

      // Source box around the iris in texture space, mapped through the
      // same texture<->canvas ratio the triangles use so content lands 1:1.
      const eyeWt = Math.hypot(tb.x - ta.x, tb.y - ta.y);
      const k = eyeWt / eyeW; // texture px per canvas px
      const m = R + 3;
      ctx.drawImage(
        this.texture,
        tc.x - m * k, tc.y - m * k, 2 * m * k, 2 * m * k,
        c.x - m + sx, c.y - m + sy, 2 * m, 2 * m
      );
      ctx.restore();
    }
  }

  /**
   * A soft dark line where the lips meet. Strongest when the mouth is
   * closed (the interior isn't drawn then), fading out as it opens — gives
   * the lips definition that the raw warp lacks.
   */
  private drawLipContactLine(pts: Point[]): void {
    if (this.innerRing.length < 6) return;
    const openness = Math.min(1, this.face.weights.jawOpen * 1.3 + this.face.weights.mouthFunnel * 0.25);
    const alpha = 0.28 * Math.max(0, 1 - openness / 0.25);
    if (alpha < 0.02) return;

    const ring = this.innerRing.map((i) => pts[i]);
    const cy = ring.reduce((s, p) => s + p.y, 0) / ring.length;
    // Corner-to-corner midline through the ring, flattened to the lip seam.
    const sorted = [...ring].sort((p, q) => p.x - q.x);
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = `rgba(70, 30, 28, ${alpha})`;
    ctx.lineWidth = Math.max(1, (sorted[sorted.length - 1].x - sorted[0].x) * 0.018);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(sorted[0].x, cy + (sorted[0].y - cy) * 0.1);
    for (let i = 1; i < sorted.length; i++) {
      ctx.lineTo(sorted[i].x, cy + (sorted[i].y - cy) * 0.1);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Mouth interior v2: angle-sorted inner-lip clip, smooth quadratic lip
   * path, fixed-size teeth hanging from the lips (the dark gap grows with
   * jawOpen, not the teeth), gum line, tongue with center groove, and an
   * inner-lip contact shadow.
   */
  /**
   * Mouth interior, built from the REAL lip curve.
   *
   * Earlier versions drew an invented symmetric lens spanning the full
   * corner-to-corner width, which put sharp dark spikes at the commissures
   * — lips do not separate at the corners. Instead:
   *   1. find the two commissures (the furthest-apart pair on the ring),
   *   2. project every lip landmark onto the corner-to-corner axis to get
   *      its position t and its perpendicular offset d (d IS the measured
   *      lip shape from the photo),
   *   3. scale d by a taper window that is zero at both corners and full
   *      mid-mouth, so the opening physically cannot part at the corners,
   *   4. draw a smooth Catmull-Rom curve through the result.
   */
  /**
   * Mouth interior, built on the measured lip seam.
   *
   * The seam (midline between opposing inner-lip landmarks) carries the
   * real position, curvature and tilt of this mouth. The opening is
   * synthesised on top of it — necessary because in a closed-lip portrait
   * the inner-lip landmarks are coincident, so there is no aperture to
   * scale. Everything is sampled along ONE parameter so x and y always
   * come from the same place on the curve; mixing parameters sheared the
   * aperture into a triangle.
   */
  private drawMouthInterior(pts: Point[]): void {
    if (this.innerRing.length < 8) return;
    const ctx = this.ctx;
    const ring = this.innerRing.map((i) => pts[i]);
    const n = ring.length;
    const half = Math.floor(n / 2);

    // Commissures: furthest-apart pair on the ring.
    let ia = 0;
    let ib = 1;
    let best = -1;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d2 = (ring[i].x - ring[j].x) ** 2 + (ring[i].y - ring[j].y) ** 2;
        if (d2 > best) {
          best = d2;
          ia = i;
          ib = j;
        }
      }
    }
    const left = ring[ia].x <= ring[ib].x ? ring[ia] : ring[ib];
    const right = ring[ia].x <= ring[ib].x ? ring[ib] : ring[ia];
    const ax = right.x - left.x;
    const ay = right.y - left.y;
    const axisLen = Math.hypot(ax, ay);
    if (axisLen < 4) return;
    const axisLen2 = axisLen * axisLen;
    // Stable opening direction: perpendicular to the corner-to-corner axis,
    // pointing down the screen.
    let axisNormX = -ay / axisLen;
    let axisNormY = ax / axisLen;
    if (axisNormY < 0) {
      axisNormX = -axisNormX;
      axisNormY = -axisNormY;
    }

    const w = this.face.weights;
    const rounding = Math.min(1, w.mouthPucker + w.mouthFunnel * 0.6);
    const openFrac =
      w.jawOpen * 0.23 + w.mouthFunnel * 0.07 + w.mouthStretch * 0.03 - w.mouthClose * 0.05;
    // Lip RETRACTION, which is a different thing from jaw opening. /f/ /v/
    // /s/ /z/ /sh/ barely drop the jaw — measured, /f/'s openFrac is exactly
    // 0.010 against a 0.012 bail, so the whole interior returned early and
    // those sounds rendered as a flat closed line. What they actually show is
    // a bright tooth edge behind pulled-back lips.
    //
    // Rounding suppression is SQUARED: linear let /ou/ (a pucker, which shows
    // nothing) leak through. The stretch deadband stops silence, which has a
    // little residual stretch, from growing teeth.
    const retract =
      Math.min(1, w.mouthStretch * 1.5 + w.mouthSmile * 0.6) *
      (1 - rounding) ** 2 *
      Math.min(1, Math.max(0, (w.mouthStretch - 0.14) / 0.16));
    // The labiodental tuck, /f/ and /v/, is the OTHER way teeth become
    // visible, and it is not retraction — the lower lip rides UP against the
    // upper incisors. For that shape mouthClose is the cause of the teeth
    // showing, not a reason to hide them, which is why gating teeth on
    // `1 - mouthClose` left /f/ at 0.058 alpha, i.e. invisible.
    //
    // mouthStretch is what separates it from a bilabial: /f/ carries ~0.25,
    // /p/ /b/ /m/ carry none, so a closed mouth stays closed.
    const tuck = w.mouthClose * Math.min(1, w.mouthStretch / 0.2) * (1 - rounding);
    const teethDrive = Math.max(retract, tuck);
    // A geometry floor, deliberately well below the cavity's 0.03 knee: /f/
    // gets an arch to hang teeth from, not a black hole.
    const synthHeight =
      Math.max(Math.max(0, openFrac), teethDrive * 0.018) * axisLen * this.tuning.mouthOpen;

    // --- Seam: midline between opposing landmarks, parameterised by t. ---
    const seam: { x: number; y: number; t: number }[] = [{ x: left.x, y: left.y, t: 0 }];
    for (let k = 1; k < half; k++) {
      const lo = ring[k];
      const up = ring[n - k];
      const sx = (lo.x + up.x) / 2;
      const sy = (lo.y + up.y) / 2;
      const t = Math.max(
        0,
        Math.min(1, ((sx - left.x) * ax + (sy - left.y) * ay) / axisLen2)
      );
      seam.push({ x: sx, y: sy, t });
    }
    seam.push({ x: right.x, y: right.y, t: 1 });
    seam.sort((p, q) => p.t - q.t);

    // Least-squares quadratic fit of the seam. Interpolating the raw
    // midpoints put a 16px step at the mouth centre — the central lip
    // landmarks take the strongest jaw displacement, so the midline
    // kinked and the aperture sheared into a hook. A real lip line is a
    // smooth curve, so fit one.
    const fitQuadratic = (values: number[], ts: number[]) => {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        const t2 = t * t;
        s0 += 1;
        s1 += t;
        s2 += t2;
        s3 += t2 * t;
        s4 += t2 * t2;
        b0 += values[i];
        b1 += values[i] * t;
        b2 += values[i] * t2;
      }
      // Solve the 3x3 normal equations by Cramer's rule.
      const det =
        s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
      if (Math.abs(det) < 1e-9) return [values[0] ?? 0, 0, 0];
      const c0 =
        (b0 * (s2 * s4 - s3 * s3) - s1 * (b1 * s4 - b2 * s3) + s2 * (b1 * s3 - b2 * s2)) / det;
      const c1 =
        (s0 * (b1 * s4 - b2 * s3) - b0 * (s1 * s4 - s3 * s2) + s2 * (s1 * b2 - s2 * b1)) / det;
      const c2 =
        (s0 * (s2 * b2 - s3 * b1) - s1 * (s1 * b2 - s2 * b1) + b0 * (s1 * s3 - s2 * s2)) / det;
      return [c0, c1, c2];
    };
    const seamTs = seam.map((q) => q.t);
    const fx = fitQuadratic(seam.map((q) => q.x), seamTs);
    const fy = fitQuadratic(seam.map((q) => q.y), seamTs);
    const seamAt = (t: number) => {
      const tc = Math.max(0, Math.min(1, t));
      return {
        x: fx[0] + fx[1] * tc + fx[2] * tc * tc,
        y: fy[0] + fy[1] * tc + fy[2] * tc * tc,
      };
    };

    // --- MEASURED parting. The jaw hinge (deformedPoints) now moves the
    // whole lower lip, so the inner rings genuinely separate in the mesh
    // and the triangles between them stretch. The painted cavity has to
    // cover exactly that region, or the stretched lip texture shows as a
    // streaked band under a too-small opening (which is what a fixed
    // fraction of mouth width produced once the lip started to move).
    //
    // Fit the upper and lower rings separately as smooth curves along the
    // mouth axis (the raw ring zigzags; that zigzag is why the aperture
    // was synthesised in the first place), then take their separation minus
    // the same separation at rest — a closed mouth's landmarks still sit a
    // few pixels apart, and that must not open a hole in silence. The seam
    // is the midpoint of each pair, so the parting splits equally above and
    // below it. ---
    const proj = (q: Point) =>
      Math.max(0, Math.min(1, ((q.x - left.x) * ax + (q.y - left.y) * ay) / axisLen2));
    const along = (q: Point) => (q.x - left.x) * axisNormX + (q.y - left.y) * axisNormY;
    const evalQ = (c: number[], t: number) => c[0] + c[1] * t + c[2] * t * t;
    const fitRing = (points: Point[]) =>
      fitQuadratic(points.map(along), points.map(proj));
    const lowerNow: Point[] = [];
    const upperNow: Point[] = [];
    const lowerRest: Point[] = [];
    const upperRest: Point[] = [];
    for (let k = 1; k < half; k++) {
      lowerNow.push(ring[k]);
      upperNow.push(ring[n - k]);
      lowerRest.push(this.mesh.basePoints[this.innerRing[k]]);
      upperRest.push(this.mesh.basePoints[this.innerRing[n - k]]);
    }
    // Four fits per frame, not four per sample.
    const fits =
      lowerNow.length >= 3
        ? { ln: fitRing(lowerNow), un: fitRing(upperNow), lr: fitRing(lowerRest), ur: fitRing(upperRest) }
        : null;
    const partingHalfAt = (t: number): number => {
      if (!fits) return 0;
      const now = evalQ(fits.ln, t) - evalQ(fits.un, t);
      const rest = evalQ(fits.lr, t) - evalQ(fits.ur, t);
      return Math.max(0, (now - rest) / 2);
    };
    let measuredMax = 0;
    for (let i = 0; i <= 8; i++) measuredMax = Math.max(measuredMax, partingHalfAt(0.2 + (i / 8) * 0.6));
    const openHeight = Math.max(synthHeight, measuredMax * 2);
    if (openHeight < axisLen * 0.010) return; // lips together

    // The aperture always ends INSIDE the commissures: its own rounded ends
    // then land on lip flesh, so the lips stay joined at the corners even
    // though the profile itself is blunt.
    // With the mesh genuinely parting, the painted opening must reach as
    // far as the parting does — the measured profile closes on its own at
    // the corners. Rounded shapes still narrow the synthetic profile.
    const spanHalf = 0.97 / 2;
    const t0 = 0.5 - spanHalf;
    const t1 = 0.5 + spanHalf;
    const synthSpanHalf = (0.84 - rounding * 0.4) / 2;

    // --- Sample upper and lower edges off the seam normal. ---
    const SAMPLES = 26;
    const LOWER_SHARE = 0.80; // the jaw drops; the upper lip barely lifts
    const UPPER_SHARE = 0.20;
    const upperPts: Point[] = [];
    const lowerPts: Point[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const u = i / SAMPLES;
      const t = t0 + u * (t1 - t0);
      const here = seamAt(t);
      // Offset along the MOUTH AXIS normal, not the local seam normal.
      // The seam comes from noisy landmarks: where it tilts steeply the
      // local normal swings toward horizontal (and the sign-flip guard
      // fires), so the opening sheared into a wedge/hook on one side. A
      // mouth opens perpendicular to its own corner-to-corner axis.
      const nx = axisNormX;
      const ny = axisNormY;
      // Superellipse profile. sin(pi*u)^1.15 leaves the ends with a slope
      // of ~1.9 — almost linear, which is exactly why the mouth read as a
      // TRIANGLE. A true ellipse has an end slope near 20 (blunt); this
      // superellipse keeps that roundness while staying slightly fuller in
      // the middle than a circle.
      const e = Math.abs(2 * u - 1);
      // Synthetic profile lives in its own (narrower, rounding-aware) span.
      const es = Math.min(1, Math.abs(t - 0.5) / synthSpanHalf);
      const gap = synthHeight * Math.pow(Math.max(0, 1 - Math.pow(es, 2.4)), 1 / 1.9);
      // Whichever is larger on each side: the mesh's own parting (the
      // stretched triangles that must be covered) or the synthetic profile
      // (retraction and teeth shapes, where the jaw barely moves).
      // The measured parting is already a smooth curve that closes where
      // the rings meet, so it is used almost to the ends: forcing it to zero
      // early left parted mesh triangles near the corners uncovered.
      const parted = partingHalfAt(t) * Math.pow(Math.max(0, 1 - Math.pow(e, 8)), 0.5);
      const lowerOff = Math.max(gap * LOWER_SHARE, parted);
      const upperOff = Math.max(gap * UPPER_SHARE, parted);
      lowerPts.push({ x: here.x + nx * lowerOff, y: here.y + ny * lowerOff });
      upperPts.push({ x: here.x - nx * upperOff, y: here.y - ny * upperOff });
    }

    // Drop the shared endpoints: at u=0 and u=1 the gap is zero, so
    // upperPts and lowerPts hold the SAME point there. Feeding coincident
    // points to Catmull-Rom gives zero-length tangents and the curve
    // overshoots into a hook/wing off the corner of the mouth.
    const outline = [...lowerPts, ...upperPts.slice(1, -1).reverse()];
    (this as unknown as { lastAperture?: unknown }).lastAperture = outline;

    const xs = outline.map((p) => p.x);
    const ys = outline.map((p) => p.y);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    if (bw < 2 || bh < 1) return;
    // Openness must come from the SYNTHESISED opening, not the drawn
    // bounding box: bh also contains this face's resting lip bow, so a
    // curved mouth reported gapRatio > 0.09 with the lips 4px apart and ran
    // the cavity at full opacity. openHeight/axisLen is identity-independent.
    const gapRatio = openHeight / Math.max(1, axisLen);
    // One opacity used to gate the cavity, the lip shading AND the teeth, all
    // keyed purely to how far the jaw had dropped. But teeth visibility is a
    // function of lip retraction, not gape: you see someone's teeth on "fifty"
    // with their jaw almost shut. Two opacities now.
    const cavityAlpha = Math.min(1, Math.max(0, (gapRatio - 0.03) / 0.04));
    const teethAlpha = Math.max(cavityAlpha, Math.min(0.85, teethDrive * 0.9));
    if (cavityAlpha <= 0.01 && teethAlpha <= 0.01) return;
    const midY = (Math.max(...ys) + Math.min(...ys)) / 2;
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;

    const aperture = smoothClosedPath(outline);

    if (this.mouthExtension) {
      const neutralA = this.mesh.basePoints[this.innerRing[ia]];
      const neutralB = this.mesh.basePoints[this.innerRing[ib]];
      // A smiling/bowed seam is not its corner chord. Seat oral geometry at
      // the measured central seam, otherwise upper incisors disappear above
      // the aperture while the lower row appears to be the upper teeth.
      const [anchorA, anchorB] = centralMouthAnchors(this.innerRing.map(i => this.mesh.basePoints[i]), neutralA, neutralB);
      ctx.save();
      try {
        this.mouthExtension.draw(ctx, {
          weights: this.face.weights,
          viseme: this.pose?.()?.viseme ?? this.speech.currentViseme(performance.now()),
          upper: upperPts, lower: lowerPts, aperture,
          neutralLeft: anchorA.x <= anchorB.x ? anchorA : anchorB,
          neutralRight: anchorA.x <= anchorB.x ? anchorB : anchorA,
          lipColour: this.samples.lipColour, skinColour: this.samples.skinColour ?? undefined, cavityAlpha, teethAlpha,
        });
      } finally { ctx.restore(); }
      return;
    }

    ctx.save();
    ctx.clip(aperture);

    ctx.globalAlpha = cavityAlpha;
    const cavity = ctx.createLinearGradient(0, midY - bh / 2, 0, midY + bh / 2);
    // Derived from this face's lips: deepest at the top where the upper lip
    // shadows the cavity, warming toward the tongue below. Never fully black
    // — a real mouth is a lit red space, not a void, and pure black reads as
    // a hole cut in the face.
    const [lr, lg, lb] = this.samples.lipColour;
    const shade = (k: number) =>
      `rgb(${Math.round(lr * k)}, ${Math.round(lg * k * 0.86)}, ${Math.round(lb * k * 0.86)})`;
    const [top, middle, bottom] = this.profile.cavityShade;
    cavity.addColorStop(0, shade(top));
    cavity.addColorStop(0.55, shade(middle));
    cavity.addColorStop(1, shade(bottom));
    ctx.fillStyle = cavity;
    ctx.fillRect(cx - bw, midY - bh, bw * 2, bh * 2);

    // --- Inner-lip depth. Without this the opening reads as a slice cut
    // through the lips. Light comes from above, so the UNDERSIDE of the
    // upper lip is deeply shadowed while the top surface of the lower lip
    // catches a wet highlight. ---
    const lipEdge = (edge: Point[], width: number, colour: string) => {
      ctx.beginPath();
      ctx.moveTo(edge[0].x, edge[0].y);
      for (let i = 1; i < edge.length; i++) ctx.lineTo(edge[i].x, edge[i].y);
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    };
    // Upper lip underside: wide soft shadow, then a tighter darker core.
    lipEdge(upperPts, bh * 0.3, "rgba(26, 8, 8, 0.38)");
    lipEdge(upperPts, bh * 0.13, "rgba(18, 5, 5, 0.42)");
    // Lower lip inner surface: shadow at the very edge, then the wet line.
    lipEdge(lowerPts, bh * 0.18, "rgba(40, 12, 12, 0.34)");
    lipEdge(
      lowerPts.map((q) => ({ x: q.x, y: q.y - bh * 0.03 })),
      Math.max(0.7, bh * 0.03),
      "rgba(255, 226, 214, 0.16)"
    );

    // --- Teeth: individual incisors hanging from the upper arch. ---
    const teethGap = 0.06 * (this.tuning.teethThreshold / DEFAULT_TUNING.teethThreshold);
    // How much of the teeth is exposed. mouthStretch used to appear here
    // twice — once inside `retract`/gapRatio and again as an explicit
    // multiplier — which is why the spread vowels saturated.
    const teethAmount =
      Math.max(
        Math.max(0, Math.min(1, (gapRatio - teethGap) / 0.08)),
        teethDrive * 0.75
      ) * Math.max(0, Math.min(1, 1 - rounding / 0.45));
    ctx.globalAlpha = 1;
    if (this.profile.teeth && teethAmount > 0.02 && teethAlpha > 0.02) {
      const upperH = Math.min(bh * 0.3, bw * 0.04) * (0.45 + 0.55 * teethAmount);
      this.drawTeethRow(upperPts, bw, teethAlpha, teethAmount, upperH, false);
      // The lower incisors are attached to the JAW, so they ride the lower
      // lip. Almost all of each tooth is hidden behind that lip — only the
      // biting tips clear it — so the row is seated ON the lower edge and
      // drawn short. Floating it into the middle of the cavity (which is
      // what flattening it toward the chord did) looks badly wrong.
      const lowerArch = lowerPts.map((q) => ({ x: q.x, y: q.y - bh * 0.055 }));
      // Lower teeth appear once there is room for them without meeting the
      // uppers — a real jaw shows them well before it is fully open.
      const room = bh - upperH * 1.35;
      const lowerH = Math.min(upperH * 0.5, room * 0.34);
      if (lowerH > 0.8) {
        // The lower row shows across the front only.
        this.drawTeethRow(lowerArch, bw, teethAlpha, teethAmount, lowerH, true, 0.3, 0.7, 0.18);
      }
      // Dissolve both rows into darkness toward the commissures, so the
      // teeth recede into the mouth instead of stopping at a hard end.
      const fade = ctx.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0);
      fade.addColorStop(0, "rgba(24, 9, 8, 0.95)");
      fade.addColorStop(0.16, "rgba(24, 9, 8, 0.55)");
      fade.addColorStop(0.34, "rgba(24, 9, 8, 0)");
      fade.addColorStop(0.66, "rgba(24, 9, 8, 0)");
      fade.addColorStop(0.84, "rgba(24, 9, 8, 0.55)");
      fade.addColorStop(1, "rgba(24, 9, 8, 0.95)");
      ctx.globalAlpha = teethAlpha;
      ctx.fillStyle = fade;
      ctx.fillRect(cx - bw / 2, midY - bh, bw, bh * 2);
      ctx.globalAlpha = 1;
    }

    // Tongue: a soft rise low in the cavity on genuinely open shapes.
    ctx.globalAlpha = cavityAlpha;
    if (gapRatio > this.profile.tongueFrom) {
      const amount = Math.min(1, (gapRatio - this.profile.tongueFrom) / 0.12);
      const ty2 = midY + bh * 0.34;
      const tongue = ctx.createRadialGradient(cx, ty2, bh * 0.06, cx, ty2, bh * 0.6);
      tongue.addColorStop(0, `rgba(176, 92, 86, ${(0.85 * amount).toFixed(3)})`);
      tongue.addColorStop(1, "rgba(120, 52, 48, 0)");
      ctx.fillStyle = tongue;
      ctx.beginPath();
      ctx.ellipse(cx, ty2, bw * 0.3, bh * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    // Soft rim so the opening blends into the lips.
    ctx.save();
    ctx.globalAlpha = cavityAlpha * 0.45;
    ctx.strokeStyle = "rgba(60, 22, 20, 0.5)";
    ctx.lineWidth = Math.max(1, bw * 0.016);
    ctx.stroke(aperture);
    ctx.restore();
  }

  /**
   * One row of teeth on a smoothed dental arch, drawn with perspective:
   * the arch curves away from the camera, so teeth toward the corners are
   * narrower, shorter, set deeper into the mouth and in shadow. Uniform
   * teeth read as a flat printed strip.
   */
  private drawTeethRow(
    arch: Point[],
    bw: number,
    alpha: number,
    exposure: number,
    height: number,
    isLower: boolean,
    // Teeth occupy only the front of the arch; the rest curves away out of
    // sight. Without this the row wrapped up around the commissures.
    spanStart = 0.08,
    spanEnd = 0.92,
    // A dental arch is far flatter than the lip opening it sits behind;
    // following the aperture curve exactly made the row dive at the sides.
    flatten = 0.3
  ): void {
    const ctx = this.ctx;
    if (arch.length < 4 || height < 0.6) return;

    // Smooth arch: a quadratic through the ends and the midpoint. Following
    // the raw samples put the teeth on a wavy line.
    // Fit the arch over the span the row actually occupies. Using
    // arch[0] / arch[last] anchored the curve on the ZERO-GAP commissure
    // samples — those sit on the seam, not on the lip, so the fitted arch
    // was pulled up off the lower lip and the row appeared to float.
    const sampleArch = (frac: number) => {
      const f = Math.max(0, Math.min(1, frac)) * (arch.length - 1);
      const i = Math.min(arch.length - 2, Math.floor(f));
      const k = f - i;
      return {
        x: arch[i].x + (arch[i + 1].x - arch[i].x) * k,
        y: arch[i].y + (arch[i + 1].y - arch[i].y) * k,
      };
    };
    const a0 = sampleArch(spanStart);
    const a1 = sampleArch(spanEnd);
    const rawMid = sampleArch((spanStart + spanEnd) / 2);
    const chordMid = { x: (a0.x + a1.x) / 2, y: (a0.y + a1.y) / 2 };
    const am = {
      x: rawMid.x + (chordMid.x - rawMid.x) * flatten,
      y: rawMid.y + (chordMid.y - rawMid.y) * flatten,
    };
    const ctrl = { x: 2 * am.x - (a0.x + a1.x) / 2, y: 2 * am.y - (a0.y + a1.y) / 2 };
    const archAt = (u: number) => {
      const k = Math.max(0, Math.min(1, u));
      const m = 1 - k;
      return {
        x: m * m * a0.x + 2 * m * k * ctrl.x + k * k * a1.x,
        y: m * m * a0.y + 2 * m * k * ctrl.y + k * k * a1.y,
      };
    };

    // Central incisors widest, narrowing to the canines.
    const widths = isLower
      ? [0.45, 0.65, 0.85, 1.0, 1.0, 0.85, 0.65, 0.45]
      : [0.42, 0.62, 0.85, 1.1, 1.1, 0.85, 0.62, 0.42];
    const total = widths.reduce((s, v) => s + v, 0);
    const dir = isLower ? -1 : 1; // lower teeth grow upward

    ctx.save();
    ctx.globalAlpha = Math.min(0.97, alpha * (0.72 + 0.28 * exposure));
    let acc = 0;
    for (let i = 0; i < widths.length; i++) {
      const u0 = acc / total;
      acc += widths[i];
      const u1 = acc / total;
      const uc = (u0 + u1) / 2;
      // Perspective: 1 at the front of the arch, 0 at the corners.
      const depth = Math.sin(Math.PI * uc);
      const h = height * (0.22 + 0.78 * depth);
      // Receding teeth sit deeper — pushed back toward the gum line.
      const recess = (1 - depth) * height * 0.95 * dir;
      const gapPx = Math.max(0.25, bw * 0.0018);

      const a = archAt(u0);
      const b = archAt(u1);
      const mid = archAt(uc);
      const ay = a.y + recess;
      const by = b.y + recess;
      const my = mid.y + recess;

      ctx.beginPath();
      ctx.moveTo(a.x + gapPx, ay);
      ctx.quadraticCurveTo(mid.x, my - 0.1 * h * dir, b.x - gapPx, by);
      ctx.lineTo(b.x - gapPx, by + h * 0.72 * dir);
      ctx.quadraticCurveTo(
        mid.x,
        my + h * 1.1 * dir,
        a.x + gapPx,
        ay + h * 0.72 * dir
      );
      ctx.closePath();

      // Darker toward the corners (in shadow) and darker overall on the
      // lower row, which sits under the upper lip's shadow.
      const tint = (isLower ? 0.42 : 0.5) + (isLower ? 0.36 : 0.5) * depth;
      const g = ctx.createLinearGradient(0, my, 0, my + h * dir);
      g.addColorStop(0, `rgba(${Math.round(236 * tint)}, ${Math.round(230 * tint)}, ${Math.round(216 * tint)}, 0.98)`);
      g.addColorStop(0.7, `rgba(${Math.round(248 * tint)}, ${Math.round(242 * tint)}, ${Math.round(228 * tint)}, 0.97)`);
      g.addColorStop(1, `rgba(${Math.round(200 * tint)}, ${Math.round(192 * tint)}, ${Math.round(176 * tint)}, 0.8)`);
      ctx.fillStyle = g;
      ctx.fill();
      // Hairline separation, as shadow rather than a cut.
      ctx.strokeStyle = "rgba(96, 74, 62, 0.2)";
      ctx.lineWidth = Math.max(0.4, bw * 0.0025);
      ctx.stroke();
    }

    // Shadow where the row meets the lip/gum.
    const first = archAt(0);
    const last = archAt(1);
    const y0 = isLower
      ? Math.max(first.y, last.y) - height * 0.1
      : Math.min(first.y, last.y) - height * 0.25;
    const shade = ctx.createLinearGradient(0, y0, 0, y0 + height * 0.7 * dir);
    shade.addColorStop(0, "rgba(70, 26, 24, 0.5)");
    shade.addColorStop(1, "rgba(70, 26, 24, 0)");
    ctx.fillStyle = shade;
    ctx.fillRect(
      Math.min(first.x, last.x),
      Math.min(y0, y0 + height * 0.7 * dir),
      Math.abs(last.x - first.x),
      height * 0.7
    );
    ctx.restore();
  }

  private drawDebugMesh(pts: Point[]): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(0, 255, 140, 0.35)";
    ctx.lineWidth = 0.5;
    for (const [a, b, c] of this.mesh.triangles) {
      ctx.beginPath();
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
      ctx.lineTo(pts[c].x, pts[c].y);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(255, 80, 80, 0.9)";
    for (const i of this.innerRing) {
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
