/**
 * Avatar3DEngine: GLB avatars (Ready Player Me / any ARKit-blendshape
 * model) rendered with Three.js. Same speech interface as the 2D engine —
 * playAudio(audio, mime, cues, onEnd) — but visemes drive morph-target
 * influences (viseme_aa, …), blinks drive eyeBlinkLeft/Right, and idle
 * motion rotates the actual Head/Neck bones.
 *
 * The orchestrator: it owns the renderer, the scene and the model, runs the
 * frame loop, and sequences the parts that do the work:
 *
 *   engine/voice.ts         the speech in flight and its clock (the 2D engine's own)
 *   engine/frame-loop.ts    the frame loop and its step (the 2D engine's own)
 *   engine/debug-handle.ts  the console handle, when a page asks for it (the 2D engine's own)
 *   engine3d/visemes.ts     the viseme tables, the cue track's targets, the ARKit decomposition
 *   engine3d/life.ts        blinks, saccades, nods
 *   engine3d/model.ts       what the model offers, the camera's stand, the influences written
 *   engine3d/head.ts        the head and neck nodes' motion
 *   engine3d/seam.ts        what the tests pose and read; in no bundle
 */
import * as THREE from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

import { NO_DEBUG_HANDLE, exposeDebugHandle } from "./engine/debug-handle";
import { FrameLoop, FrameStep } from "./engine/frame-loop";
import { Voice } from "./engine/voice";
import { HeadBones, type HeadPoseDriver } from "./engine3d/head";
import { FaceLife, lookMorphs } from "./engine3d/life";
import { applyMorphs, clearMorphs, findModelParts, frameCamera, type FrameSpec, type MorphMesh } from "./engine3d/model";
import {
  DEFAULT_VISEME_ARKIT,
  MORPH_NAMES,
  arkitNamesOf,
  cueMorphTargets,
  dampMorphs,
  decomposeVisemes,
  restingMorphs,
  type ArkitWeights,
} from "./engine3d/visemes";
import { DEFAULT_TUNING, type Cue, type EngineTuning } from "./types";

export type { HeadPose, HeadPoseDriver } from "./engine3d/head";

// KTX2 texture transcoding needs WASM binaries; loaded from CDN on demand
// (only models with KTX2 textures pay this cost).
const BASIS_TRANSCODER_PATH = "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/basis/";

/** What a model may ask of the engine beyond its geometry. Every field is
 *  optional and its absence is exactly the engine as it was: Ready Player
 *  Me and Avaturn models pass nothing. A head3d GLB (head3d/load.ts)
 *  carries its rig's own viseme table, a lighting that suits a photograph,
 *  where to frame, and a livelier head. */
export interface Avatar3DOptions {
  /** Viseme -> ARKit weights, replacing the built-in decomposition. */
  visemes?: Record<string, ArkitWeights>;
  /** Light intensities (and the hemisphere's ground colour). */
  lights?: { hemisphere: number; key: number; groundColor?: number };
  /** Frame the camera on this centre with this visible height (model units)
   *  instead of guessing from the Head bone and the bounds. */
  frame?: FrameSpec;
  /** The head's idle motion. */
  headPose?: HeadPoseDriver;
  /** Put the engine on `globalThis.__liveface3d` for the console, until
   *  `destroy()`; off by default (engine/debug-handle.ts). */
  debug?: boolean;
}

const DEFAULT_LIGHTS = { hemisphere: 1.4, key: 1.6, groundColor: 0x8888aa };

export class Avatar3DEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  /** Every mesh with morph targets. */
  private readonly morphMeshes: MorphMesh[];
  /** The head and neck nodes and their motion (head.ts). */
  private readonly head: HeadBones;
  /** Blinks, saccades, nods (life.ts). */
  private readonly life = new FaceLife();
  /** The speech in flight: cue track, clock, audio (engine/voice.ts). */
  private readonly speech = new Voice(undefined, {
    onSync: () => undefined,
    onEnded: () => this.finishSpeech(),
  });
  private destroyed = false;
  /** No viseme targets on the model: the visemes drive ARKit blendshapes. */
  private readonly useArkit: boolean;
  /** The viseme decomposition in use and the ARKit names it drives. */
  private readonly visemeTable: Record<string, ArkitWeights>;
  private readonly arkitNames: string[];
  /** Every target the speech drives, which a still rests. */
  private readonly speechNames: string[];
  /** Morph weights by target name held in place of the cue track (a still,
   *  a test); null lets the speech drive them. */
  private heldMorphs: Record<string, number> | null = null;
  private readonly frameStep = new FrameStep();
  /** Live animation parameters — mouthOpen/smoothness/headMotion apply
   * (teeth are part of the model's own geometry in 3D). */
  tuning: EngineTuning = { ...DEFAULT_TUNING };
  private readonly frameLoop: FrameLoop;
  private readonly startTime = performance.now();
  /** The viseme morphs' weights now, damped toward the cue track's. */
  private readonly morphWeights = restingMorphs();
  /** Smoothed speech energy, 0..1: how much the head and brows move. */
  private energy = 0;
  /** Takes the console handle back (Avatar3DOptions.debug). */
  private readonly releaseDebugHandle: () => void;

  static async load(canvas: HTMLCanvasElement, modelUrl: string, options: Avatar3DOptions = {}): Promise<Avatar3DEngine> {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    const ktx2 = new KTX2Loader()
      .setTranscoderPath(BASIS_TRANSCODER_PATH)
      .detectSupport(renderer);
    const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
    try {
      const gltf = await loader.loadAsync(modelUrl);
      return new Avatar3DEngine(canvas, gltf.scene, renderer, options);
    } finally {
      ktx2.dispose();
    }
  }

  constructor(canvas: HTMLCanvasElement, model: THREE.Group, renderer?: THREE.WebGLRenderer, options: Avatar3DOptions = {}) {
    this.visemeTable = options.visemes ?? DEFAULT_VISEME_ARKIT;
    this.arkitNames = arkitNamesOf(this.visemeTable);
    this.speechNames = [...MORPH_NAMES, ...this.arkitNames];
    const lights = { ...DEFAULT_LIGHTS, ...(options.lights ?? {}) };
    this.renderer = renderer ?? new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    // setSize writes the scaled buffer size back into canvas.width — so a
    // re-created engine (StrictMode remounts, HMR) must NOT read
    // canvas.width as its base size or the buffer inflates exponentially.
    // Remember the original logical size on the element.
    const baseW = Number(canvas.dataset.lfBaseW ?? (canvas.dataset.lfBaseW = String(canvas.width)));
    const baseH = Number(canvas.dataset.lfBaseH ?? (canvas.dataset.lfBaseH = String(canvas.height)));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(baseW, baseH, false);
    this.camera = new THREE.PerspectiveCamera(30, baseW / baseH, 0.01, 50);

    this.scene.add(new THREE.HemisphereLight(0xffffff, lights.groundColor, lights.hemisphere));
    const key = new THREE.DirectionalLight(0xffffff, lights.key);
    key.position.set(0.5, 1.2, 1.5);
    this.scene.add(key);
    this.scene.add(model);

    const parts = findModelParts(model);
    this.morphMeshes = parts.morphMeshes;
    // Drive viseme_* morphs when present (RPM convention); otherwise
    // decompose visemes into raw ARKit blendshapes.
    this.useArkit = !parts.visemeMorphs;
    this.head = new HeadBones(parts.headBone, parts.neckBone, options.headPose ?? null);
    frameCamera(this.camera, model, parts.headBone, options.frame);

    this.life.start(performance.now());
    this.frameLoop = new FrameLoop((now) => this.step(now));
    this.releaseDebugHandle = options.debug ? exposeDebugHandle("__liveface3d", this) : NO_DEBUG_HANDLE;
  }

  destroy(): void {
    this.destroyed = true;
    this.frameLoop.stop();
    this.speech.stopAudio();
    this.renderer.dispose();
    this.releaseDebugHandle();
  }

  // --- Speech API (same shape as the 2D engine) ---

  /**
   * Play base64 audio with a viseme cue track, timed as the 2D engine times
   * it (media-clock.ts): cue time is the audio element's own position, held
   * at 0 until the voice is actually playing, re-anchored on `playing` and
   * `seeked`, followed every frame, and standing still with the mouth
   * closed while the element is paused. A clock started at play() ran ahead
   * of the voice by however long the audio took to start, for the whole
   * utterance.
   */
  playAudio(audioB64: string, mime: string, cues: Cue[], onEnd?: () => void): void {
    const audio = this.speech.load(audioB64, mime, onEnd ?? null);
    this.speech.begin(cues);
    // Never through the analyser: the 3D mouth has no amplitude fallback.
    this.speech.play(audio);
  }

  /** Drive lip-sync from an externally played voice (e.g. speechSynthesis). */
  playCues(cues: Cue[]): void {
    this.speech.stopAudio();
    this.speech.begin(cues);
    this.speech.startClock(performance.now());
  }

  /** Re-align the cue clock to a known position in the track (ms). */
  syncCueTime(ms: number): void {
    this.speech.seek(ms, performance.now());
  }

  stopSpeech(): void {
    this.speech.stop();
  }

  isSpeaking(): boolean {
    return this.speech.speaking;
  }

  /** Hold these morph targets, by name (viseme_aa, jawOpen...), instead of
   *  the cue track's (a still of one shape, a test): every speech-driven
   *  target not named goes to 0; null hands the mouth back to speech.
   *  Blinks, gaze and the head carry on. */
  holdMorphs(weights: Record<string, number> | null): void {
    // A target held outside the speech set would otherwise keep its value
    // after release, since speech never writes it.
    clearMorphs(this.morphMeshes, Object.keys(this.heldMorphs ?? {}));
    this.heldMorphs = weights ? { ...weights } : null;
  }

  /** One frame now: animate and draw. For harnesses and tests that drive
   *  the clock themselves; the animation loop calls the same two steps. */
  step(now: number = performance.now()): void {
    this.tick(now);
    this.renderer.render(this.scene, this.camera);
  }

  /** What the last frame cost the GPU. */
  stats(): { calls: number; triangles: number } {
    const info = this.renderer.info.render;
    return { calls: info.calls, triangles: info.triangles };
  }

  /** The voice ended on its own: the track dropped, then the caller's onEnd. */
  private finishSpeech(): void {
    const onEnd = this.speech.finish();
    if (onEnd && !this.destroyed) onEnd();
  }

  // --- Animation ---

  /** The cue track's viseme targets now; at rest when not speaking or while
   *  the voice is paused (the mouth closes rather than freezing mid-vowel). */
  private cueTargets(now: number): Record<string, number> {
    const speech = this.speech;
    if (!speech.speaking || !speech.cues.length || speech.voicePaused()) return restingMorphs();
    return cueMorphTargets(speech.cues, speech.cueTime(now));
  }

  private tick(now: number): void {
    const speaking = this.speech.speaking;
    const jaw = dampMorphs(this.morphWeights, this.cueTargets(now), this.tuning.mouthOpen, this.tuning.smoothness);
    this.energy += ((speaking ? jaw : 0) - this.energy) * 0.06;

    const blink = this.life.blink(now);
    const arkit = this.useArkit && !this.heldMorphs
      ? decomposeVisemes(this.morphWeights, this.visemeTable, this.arkitNames)
      : null;
    // Saccades: the 2D engine's behaviour, through the ARKit eyeLook* morphs.
    const look = lookMorphs(this.life.look(now, speaking), blink);
    applyMorphs(this.morphMeshes, {
      held: this.heldMorphs,
      speechNames: this.speechNames,
      arkit,
      visemes: this.morphWeights,
      blink,
      look,
      brow: 0.08 + this.energy * 0.15,
    });

    // Idle head motion on real bones: subtle yaw/pitch drift + nods.
    const nod = this.life.nod(now, speaking);
    const dt = this.frameStep.next(now);
    this.head.update({
      t: (now - this.startTime) / 1000,
      now,
      dt,
      speaking,
      energy: this.energy,
      nod,
      headMotion: this.tuning.headMotion,
    });
  }
}
