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
import { Cue } from "./types";

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
const ARKIT_NAMES = [...new Set(Object.values(VISEME_TO_ARKIT).flatMap((w) => Object.keys(w)))];

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
  private currentAudio: HTMLAudioElement | null = null;
  private onAudioEnd: (() => void) | null = null;

  static async load(canvas: HTMLCanvasElement, modelUrl: string): Promise<Avatar3DEngine> {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    const ktx2 = new KTX2Loader()
      .setTranscoderPath(BASIS_TRANSCODER_PATH)
      .detectSupport(renderer);
    const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
    try {
      const gltf = await loader.loadAsync(modelUrl);
      return new Avatar3DEngine(canvas, gltf.scene, renderer);
    } finally {
      ktx2.dispose();
    }
  }

  constructor(canvas: HTMLCanvasElement, model: THREE.Group, renderer?: THREE.WebGLRenderer) {
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

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8888aa, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
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

  playAudio(audioB64: string, mime: string, cues: Cue[], onEnd?: () => void): void {
    this.stopAudio();
    const audio = new Audio(`data:${mime};base64,${audioB64}`);
    this.currentAudio = audio;
    this.onAudioEnd = onEnd ?? null;
    this.cues = prepareCues(cues);
    this.speaking = true;
    audio.addEventListener("ended", () => audio === this.currentAudio && this.finishSpeech());
    audio.addEventListener("error", () => audio === this.currentAudio && this.finishSpeech());
    const playPromise = audio.play();
    this.cueStart = performance.now();
    playPromise?.catch(() => audio === this.currentAudio && this.finishSpeech());
  }

  stopSpeech(): void {
    this.stopAudio();
    this.speaking = false;
    this.cues = [];
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  private finishSpeech(): void {
    this.speaking = false;
    this.cues = [];
    const callback = this.onAudioEnd;
    this.onAudioEnd = null;
    this.currentAudio = null;
    if (callback && !this.destroyed) callback();
  }

  private stopAudio(): void {
    if (this.currentAudio) {
      const audio = this.currentAudio;
      this.currentAudio = null;
      this.onAudioEnd = null;
      audio.pause();
      audio.src = "";
    }
  }

  // --- Animation ---

  /** Co-articulated target weights per morph name (same scheme as 2D). */
  private cueTargets(now: number): Record<string, number> {
    const targets: Record<string, number> = {};
    for (const name of MORPH_NAMES) targets[name] = 0;
    if (!this.speaking || !this.cues.length) return targets;
    const t = now - this.cueStart;
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
      const target = targets[name] ?? 0;
      const rate = target > this.morphWeights[name] ? 0.35 : 0.2;
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
    if (this.useArkit) {
      for (const name of ARKIT_NAMES) arkitValues[name] = 0;
      for (const [viseme, morphName] of Object.entries(VISEME_TO_MORPH)) {
        const weight = this.morphWeights[morphName];
        if (weight < 0.01) continue;
        for (const [arkitName, value] of Object.entries(VISEME_TO_ARKIT[viseme] ?? {})) {
          arkitValues[arkitName] = Math.min(1, (arkitValues[arkitName] ?? 0) + value * weight);
        }
      }
    }

    // Apply morphs to every mesh that has them (head, teeth, eyes...).
    for (const { dictionary, influences } of this.morphMeshes) {
      if (this.useArkit) {
        for (const name of ARKIT_NAMES) {
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
    const amp = 0.35 + this.energy * 0.65;
    if (this.headBone) {
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
