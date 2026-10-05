/**
 * Avatar3DEngine: GLB avatars (Ready Player Me / any ARKit-blendshape
 * model) rendered with Three.js. Same speech interface as the 2D engine —
 * playAudio(audio, mime, cues, onEnd) — but visemes drive morph-target
 * influences (viseme_aa, …), blinks drive eyeBlinkLeft/Right, and idle
 * motion rotates the actual Head/Neck bones.
 */
import * as THREE from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

// KTX2 texture transcoding needs WASM binaries; loaded from CDN on demand
// (only models with KTX2 textures pay this cost).
const BASIS_TRANSCODER_PATH = "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/basis/";

import { prepareCues } from "./engine";
import { MediaClock } from "./media-clock";
import { Cue, DEFAULT_TUNING, EngineTuning } from "./types";

// Oculus viseme -> Ready Player Me morph-target name. Note ih/oh/ou are
// I/O/U in RPM's naming.
const VISEME_TO_MORPH: Record<string, string> = {
  sil: "viseme_sil", PP: "viseme_PP", FF: "viseme_FF", TH: "viseme_TH",
  DD: "viseme_DD", kk: "viseme_kk", CH: "viseme_CH", SS: "viseme_SS",
  nn: "viseme_nn", RR: "viseme_RR", aa: "viseme_aa", E: "viseme_E",
  ih: "viseme_I", oh: "viseme_O", ou: "viseme_U",
};
const MORPH_NAMES = Object.values(VISEME_TO_MORPH);

// Fallback for models WITHOUT viseme morphs but WITH raw ARKit blendshapes
// (Avaturn, Avatar SDK, Blender ARKit rigs, three.js facecap...). Each
// viseme decomposes into ARKit weights — same table the 2D rig uses.
type ArkitWeights = Record<string, number>;
const VISEME_TO_ARKIT: Record<string, ArkitWeights> = {
  sil: { mouthClose: 0.1 },
  PP: { jawOpen: 0.05, mouthClose: 0.9, mouthPucker: 0.25 },
  FF: { jawOpen: 0.1, mouthClose: 0.55, mouthStretchLeft: 0.25, mouthStretchRight: 0.25 },
  TH: { jawOpen: 0.25, mouthClose: 0.2, mouthFunnel: 0.15 },
  DD: { jawOpen: 0.3, mouthClose: 0.15, mouthStretchLeft: 0.25, mouthStretchRight: 0.25 },
  kk: { jawOpen: 0.35, mouthClose: 0.1, mouthFunnel: 0.1 },
  CH: { jawOpen: 0.25, mouthPucker: 0.35, mouthFunnel: 0.4 },
  SS: { jawOpen: 0.15, mouthStretchLeft: 0.45, mouthStretchRight: 0.45, mouthSmileLeft: 0.25, mouthSmileRight: 0.25 },
  nn: { jawOpen: 0.2, mouthClose: 0.25, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 },
  RR: { jawOpen: 0.25, mouthPucker: 0.3, mouthFunnel: 0.3 },
  aa: { jawOpen: 0.85, mouthFunnel: 0.1, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 },
  E: { jawOpen: 0.45, mouthStretchLeft: 0.5, mouthStretchRight: 0.5, mouthSmileLeft: 0.35, mouthSmileRight: 0.35 },
  ih: { jawOpen: 0.3, mouthStretchLeft: 0.45, mouthStretchRight: 0.45, mouthSmileLeft: 0.3, mouthSmileRight: 0.3 },
  oh: { jawOpen: 0.6, mouthPucker: 0.5, mouthFunnel: 0.55 },
  ou: { jawOpen: 0.35, mouthPucker: 0.85, mouthFunnel: 0.6 },
};
const arkitNamesOf = (table: Record<string, ArkitWeights>) =>
  [...new Set(Object.values(table).flatMap((w) => Object.keys(w)))];

/** A head pose in radians, applied over the model's rest pose. */
export interface HeadPose { yaw: number; pitch: number; roll: number }

/** Drives the head's idle motion in place of the built-in drift: called
 *  once per frame with the step in ms, the frame time, whether the avatar
 *  is speaking and its smoothed speech energy (0..1). */
export interface HeadPoseDriver {
  update(dt: number, now: number, speaking: boolean, energy: number): HeadPose;
}

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
  frame?: { center: [number, number, number]; height: number };
  /** The head's idle motion. */
  headPose?: HeadPoseDriver;
}

const DEFAULT_LIGHTS = { hemisphere: 1.4, key: 1.6, groundColor: 0x8888aa };

/** Look up a morph index tolerating both ARKit suffix conventions
 * (mouthSmileLeft vs mouthSmile_L). */
function morphIndex(dictionary: Record<string, number>, name: string): number | undefined {
  if (name in dictionary) return dictionary[name];
  const aliased = name.replace(/Left$/, "_L").replace(/Right$/, "_R");
  return dictionary[aliased];
}

interface MorphMesh {
  mesh: THREE.Mesh;
  dictionary: Record<string, number>;
  influences: number[];
}

export class Avatar3DEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private morphMeshes: MorphMesh[] = [];
  private headBone: THREE.Object3D | null = null;
  private neckBone: THREE.Object3D | null = null;
  private headRest = new THREE.Euler();
  private neckRest = new THREE.Euler();
  private destroyed = false;
  private useArkit = false;
  /** The viseme decomposition in use and the ARKit names it drives. */
  private readonly visemeTable: Record<string, ArkitWeights>;
  private readonly arkitNames: string[];
  private readonly frameSpec: Avatar3DOptions["frame"];
  private readonly headPose: HeadPoseDriver | null;
  /** Morph weights by target name held in place of the cue track (a still,
   *  a test); null lets the speech drive them. */
  private heldMorphs: Record<string, number> | null = null;
  private lastTickAt = 0;
  /** Live animation parameters — mouthOpen/smoothness/headMotion apply
   * (teeth are part of the model's own geometry in 3D). */
  tuning: EngineTuning = { ...DEFAULT_TUNING };
  private raf = 0;
  private startTime = performance.now();

  // Speech state (mirrors the 2D engine)
  private cues: Cue[] = [];
  private cueStart = 0;
  private speaking = false;
  private morphWeights: Record<string, number> = {};
  private energy = 0;
  private blink = 0;
  private nextBlinkAt = 0;
  private nodPhase = 1;
  private nextNodAt = 0;
  private gaze = { x: 0, y: 0 };
  private gazeTarget = { x: 0, y: 0 };
  private nextSaccadeAt = 0;
  private currentAudio: HTMLAudioElement | null = null;
  /** Cue time of the audio playing now: the element's own position. */
  private audioClock: MediaClock | null = null;
  private onAudioEnd: (() => void) | null = null;

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
    this.visemeTable = options.visemes ?? VISEME_TO_ARKIT;
    this.arkitNames = arkitNamesOf(this.visemeTable);
    this.frameSpec = options.frame;
    this.headPose = options.headPose ?? null;
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

    let hasVisemeMorphs = false;
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
        this.morphMeshes.push({
          mesh,
          dictionary: mesh.morphTargetDictionary as Record<string, number>,
          influences: mesh.morphTargetInfluences,
        });
        if ("viseme_aa" in mesh.morphTargetDictionary) hasVisemeMorphs = true;
      }
      const lower = object.name.toLowerCase();
      if (!this.headBone && lower.includes("head") && !lower.includes("top")) this.headBone = object;
      if (!this.neckBone && lower.includes("neck")) this.neckBone = object;
    });
    // Drive viseme_* morphs when present (RPM convention); otherwise
    // decompose visemes into raw ARKit blendshapes.
    this.useArkit = !hasVisemeMorphs;
    if (this.headBone) this.headRest.copy(this.headBone.rotation);
    if (this.neckBone) this.neckRest.copy(this.neckBone.rotation);
    for (const name of MORPH_NAMES) this.morphWeights[name] = 0;

    this.frameHead(model);

    const now = performance.now();
    this.nextBlinkAt = now + 1200 + Math.random() * 2000;
    this.nextNodAt = now + 2500;
    this.nextSaccadeAt = now + 600 + Math.random() * 1200;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    (globalThis as { __liveface3d?: Avatar3DEngine }).__liveface3d = this;
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.stopAudio();
    this.renderer.dispose();
  }

  /** Frame head-and-shoulders: target the Head bone if present, else bbox top. */
  private frameHead(model: THREE.Group): void {
    model.updateWorldMatrix(true, true);
    if (this.frameSpec) {
      // The model says where to look and how much to show.
      const centre = new THREE.Vector3(...this.frameSpec.center);
      const distance = (this.frameSpec.height / 2) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
      this.camera.position.set(centre.x, centre.y, centre.z + distance);
      this.camera.lookAt(centre);
      return;
    }
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const target = new THREE.Vector3();
    if (this.headBone) {
      this.headBone.getWorldPosition(target);
      target.y += size.y * 0.01;
    } else {
      // Boneless = a face shell from the GLB generator: aim at its center.
      box.getCenter(target);
    }
    // Boneless models are face shells from the GLB generator: frame tighter.
    const distance = this.headBone
      ? Math.max(size.x, size.y * 0.35) * 1.9 + 0.25
      : Math.max(size.x, size.y) * 1.35 + 0.12;
    this.camera.position.set(target.x, target.y + 0.02, target.z + distance);
    this.camera.lookAt(target);
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
    this.stopAudio();
    const audio = new Audio(`data:${mime};base64,${audioB64}`);
    this.currentAudio = audio;
    const clock = new MediaClock(audio);
    this.audioClock = clock;
    const sync = () => {
      if (audio === this.currentAudio) clock.sync(performance.now());
    };
    audio.addEventListener("playing", sync);
    audio.addEventListener("seeked", sync);
    this.onAudioEnd = onEnd ?? null;
    this.cues = prepareCues(cues);
    this.speaking = true;
    audio.addEventListener("ended", () => audio === this.currentAudio && this.finishSpeech());
    audio.addEventListener("error", () => audio === this.currentAudio && this.finishSpeech());
    const playPromise = audio.play();
    this.cueStart = performance.now();
    playPromise?.catch(() => audio === this.currentAudio && this.finishSpeech());
  }

  /** Drive lip-sync from an externally played voice (e.g. speechSynthesis). */
  playCues(cues: Cue[]): void {
    this.stopAudio();
    this.cues = prepareCues(cues);
    this.speaking = true;
    this.cueStart = performance.now();
  }

  /** Re-align the cue clock to a known position in the track (ms). */
  syncCueTime(ms: number): void {
    this.cueStart = performance.now() - ms;
  }

  stopSpeech(): void {
    this.stopAudio();
    this.speaking = false;
    this.cues = [];
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  /** Hold these morph targets, by name (viseme_aa, jawOpen...), instead of
   *  the cue track's (a still of one shape, a test): every speech-driven
   *  target not named goes to 0; null hands the mouth back to speech.
   *  Blinks, gaze and the head carry on. */
  holdMorphs(weights: Record<string, number> | null): void {
    // A target held outside the speech set would otherwise keep its value
    // after release, since speech never writes it.
    for (const name of Object.keys(this.heldMorphs ?? {})) {
      for (const { dictionary, influences } of this.morphMeshes) {
        const index = morphIndex(dictionary, name);
        if (index !== undefined) influences[index] = 0;
      }
    }
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

  private finishSpeech(): void {
    this.speaking = false;
    this.cues = [];
    const callback = this.onAudioEnd;
    this.onAudioEnd = null;
    this.currentAudio = null;
    this.audioClock = null;
    if (callback && !this.destroyed) callback();
  }

  private stopAudio(): void {
    // Cue time goes back to the frame clock (playCues, the next playAudio).
    this.audioClock = null;
    if (this.currentAudio) {
      const audio = this.currentAudio;
      this.currentAudio = null;
      this.onAudioEnd = null;
      audio.pause();
      audio.src = "";
    }
  }

  // --- Animation ---

  private cueTime(now: number): number {
    if (this.audioClock) return this.audioClock.read(now);
    return now - this.cueStart;
  }

  /** Co-articulated target weights per morph name (same scheme as 2D). A
   *  paused voice closes the mouth rather than freezing it mid-vowel. */
  private cueTargets(now: number): Record<string, number> {
    const targets: Record<string, number> = {};
    for (const name of MORPH_NAMES) targets[name] = 0;
    if (!this.speaking || !this.cues.length || this.audioClock?.paused) return targets;
    const t = this.cueTime(now);
    let index = -1;
    for (let i = 0; i < this.cues.length; i++) {
      if (this.cues[i].t <= t) index = i;
      else break;
    }
    if (index < 0) return targets;
    const curr = VISEME_TO_MORPH[this.cues[index].viseme];
    const next = this.cues[index + 1];
    if (!next || next.t <= this.cues[index].t) {
      if (curr && curr !== "viseme_sil") targets[curr] = 0.85;
      return targets;
    }
    const f = Math.min(1, Math.max(0, (t - this.cues[index].t) / (next.t - this.cues[index].t)));
    const nextMorph = VISEME_TO_MORPH[next.viseme];
    if (curr && curr !== "viseme_sil") targets[curr] = 0.85 * (1 - f);
    if (nextMorph && nextMorph !== "viseme_sil") targets[nextMorph] = (targets[nextMorph] ?? 0) + 0.85 * f;
    return targets;
  }

  private loop(now: number): void {
    if (this.destroyed) return;
    this.tick(now);
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.loop);
  }

  private tick(now: number): void {
    const t = (now - this.startTime) / 1000;

    // Visemes: damp toward co-articulated targets.
    const targets = this.cueTargets(now);
    let jaw = 0;
    for (const name of MORPH_NAMES) {
      const target = Math.min(1, (targets[name] ?? 0) * this.tuning.mouthOpen);
      const rate = Math.min(
        0.6,
        (target > this.morphWeights[name] ? 0.35 : 0.2) * this.tuning.smoothness
      );
      this.morphWeights[name] += (target - this.morphWeights[name]) * rate;
      if (name !== "viseme_sil") jaw = Math.max(jaw, this.morphWeights[name]);
    }
    this.energy += ((this.speaking ? jaw : 0) - this.energy) * 0.06;

    // Blinks.
    if (now >= this.nextBlinkAt) {
      this.nextBlinkAt = now + 2200 + Math.random() * 3200;
      this.blink = 0.0001;
    }
    if (this.blink > 0) {
      this.blink += 16 / 240;
      if (this.blink >= 1) this.blink = 0;
    }
    const blinkAmount =
      this.blink <= 0 ? 0
      : this.blink < 0.4 ? Math.sin((this.blink / 0.4) * (Math.PI / 2))
      : Math.cos(((this.blink - 0.4) / 0.6) * (Math.PI / 2));

    // ARKit fallback: decompose viseme weights into blendshape values.
    const arkitValues: Record<string, number> = {};
    if (this.useArkit && !this.heldMorphs) {
      for (const name of this.arkitNames) arkitValues[name] = 0;
      for (const [viseme, morphName] of Object.entries(VISEME_TO_MORPH)) {
        const weight = this.morphWeights[morphName];
        if (weight < 0.01) continue;
        for (const [arkitName, value] of Object.entries(this.visemeTable[viseme] ?? {})) {
          arkitValues[arkitName] = Math.min(1, (arkitValues[arkitName] ?? 0) + value * weight);
        }
      }
    }

    // Saccades: same behaviour as the 2D engine, expressed through the
    // ARKit eyeLook* morphs (models that lack them simply ignore these).
    if (now >= this.nextSaccadeAt) {
      const spread = this.speaking ? 0.16 : 0.3;
      this.nextSaccadeAt =
        now + (this.speaking ? 900 : 1400) + Math.random() * (this.speaking ? 1600 : 2600);
      this.gazeTarget = {
        x: (Math.random() * 2 - 1) * spread,
        y: (Math.random() * 2 - 1) * spread * 0.5,
      };
    }
    this.gaze.x += (this.gazeTarget.x - this.gaze.x) * 0.35;
    this.gaze.y += (this.gazeTarget.y - this.gaze.y) * 0.35;
    const gazeDamp = 1 - blinkAmount;
    const look = {
      eyeLookOutLeft: Math.max(0, -this.gaze.x) * gazeDamp,
      eyeLookInLeft: Math.max(0, this.gaze.x) * gazeDamp,
      eyeLookOutRight: Math.max(0, this.gaze.x) * gazeDamp,
      eyeLookInRight: Math.max(0, -this.gaze.x) * gazeDamp,
      eyeLookUpLeft: Math.max(0, -this.gaze.y) * gazeDamp,
      eyeLookUpRight: Math.max(0, -this.gaze.y) * gazeDamp,
      eyeLookDownLeft: Math.max(0, this.gaze.y) * gazeDamp,
      eyeLookDownRight: Math.max(0, this.gaze.y) * gazeDamp,
    };

    // Apply morphs to every mesh that has them (head, teeth, eyes...).
    for (const { dictionary, influences } of this.morphMeshes) {
      if (this.heldMorphs) {
        // A still: the speech-driven targets rest, the held ones are set.
        for (const name of [...MORPH_NAMES, ...this.arkitNames]) {
          const index = morphIndex(dictionary, name);
          if (index !== undefined) influences[index] = 0;
        }
        for (const [name, value] of Object.entries(this.heldMorphs)) {
          const index = morphIndex(dictionary, name);
          if (index !== undefined) influences[index] = value;
        }
      } else if (this.useArkit) {
        for (const name of Object.keys(arkitValues)) {
          const index = morphIndex(dictionary, name);
          if (index !== undefined) influences[index] = arkitValues[name];
        }
      } else {
        for (const name of MORPH_NAMES) {
          const index = dictionary[name];
          if (index !== undefined) influences[index] = this.morphWeights[name];
        }
      }
      for (const lid of ["eyeBlinkLeft", "eyeBlinkRight"]) {
        const index = morphIndex(dictionary, lid);
        if (index !== undefined) influences[index] = blinkAmount;
      }
      for (const [name, value] of Object.entries(look)) {
        const index = morphIndex(dictionary, name);
        if (index !== undefined) influences[index] = value;
      }
      const brow = dictionary["browInnerUp"];
      if (brow !== undefined) influences[brow] = 0.08 + this.energy * 0.15;
    }

    // Idle head motion on real bones: subtle yaw/pitch drift + nods.
    if (this.speaking && now >= this.nextNodAt) {
      this.nextNodAt = now + 1800 + Math.random() * 2600;
      this.nodPhase = 0;
    }
    if (this.nodPhase < 1) this.nodPhase = Math.min(1, this.nodPhase + 16 / 650);
    const nod = this.nodPhase < 1 ? Math.sin(this.nodPhase * Math.PI) : 0;
    const amp = (0.35 + this.energy * 0.65) * this.tuning.headMotion;
    const dt = Math.min(64, Math.max(4, now - (this.lastTickAt || now - 16.7)));
    this.lastTickAt = now;
    if (this.headBone && this.headPose) {
      // A driver's pose, scaled by the owner's head-motion setting, with
      // the speech nods on top.
      const pose = this.headPose.update(dt, now, this.speaking, this.energy);
      const s = this.tuning.headMotion;
      this.headBone.rotation.y = this.headRest.y + pose.yaw * s;
      this.headBone.rotation.x = this.headRest.x + pose.pitch * s + nod * 0.05 * this.energy;
      this.headBone.rotation.z = this.headRest.z + pose.roll * s;
    } else if (this.headBone) {
      this.headBone.rotation.y = this.headRest.y + (Math.sin(t * 0.43) * 0.05 + Math.sin(t * 0.117) * 0.04) * amp;
      this.headBone.rotation.x = this.headRest.x + Math.sin(t * 0.31 + 1.3) * 0.03 * amp + nod * 0.05 * this.energy;
      this.headBone.rotation.z = this.headRest.z + Math.sin(t * 0.27 + 0.7) * 0.015 * amp;
    }
    if (this.neckBone) {
      this.neckBone.rotation.y = this.neckRest.y + Math.sin(t * 0.43) * 0.02 * amp;
      this.neckBone.rotation.x = this.neckRest.x + Math.sin(t * 0.9) * 0.006; // breathing
    }
  }
}
