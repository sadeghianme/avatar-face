/**
 * Experimental 2.5D renderer for the Photoface HD lab.
 *
 * SEPARATION CONTRACT — the reason this file lives under lab/:
 *
 *   * Dependencies flow ONE WAY. This module imports stable code
 *     (AvatarEngine helpers, HeadMotion, BodyMotion, the types); nothing
 *     under src/ outside lab/ may ever import from lab/. Deleting this
 *     directory must leave the product exactly as it was.
 *   * It is not exported from index.ts and not part of the widget bundles,
 *     so neither three.js nor any lab behaviour can reach a customer page.
 *   * The dashboard reaches it only through the lab page's dynamic import.
 *
 * Reusing HeadMotion/BodyMotion is inside that contract: importing a class
 * cannot change the class. The first version drove the head with summed
 * sines instead — the exact approach headmotion.ts documents rejecting,
 * because a sum of sines never stops moving and the eye learns the loop.
 * Judging depth rendering over looping motion made every comparison unfair
 * to the depth idea itself.
 */
import * as THREE from "three";

import { BodyMotion } from "../bodymotion";
import { prepareCues } from "../engine";
import { HeadMotion } from "../headmotion";
import type { SpeechPlayer } from "../speech";
import type { BlendWeights, Cue, Rig } from "../types";
import { ZERO_WEIGHTS } from "../types";

export interface PhotoFaceHDSource {
  rigUrl: string;
  imageUrl: string;
  layerUrls?: {
    background?: string;
    body?: string;
    head?: string;
  } | null;
  /** Per-landmark z from MediaPipe (478 values, negative toward the camera),
   *  served by the lab depth endpoint. Optional: without it the surface
   *  falls back to the dome approximation. */
  depthZ?: number[] | null;
}

/**
 * Pose scale: HeadMotion emits -1..1 of "peak travel"; these are the peaks
 * in radians. Chosen to match the 2D engine's apparent amplitude so the
 * side-by-side comparison shows DEPTH difference, not amplitude difference.
 */
export const POSE_SCALE = {
  yawRad: 0.05,
  pitchRad: 0.03,
  rollRad: 0.014,
  swayRad: 0.008,
  breathRise: 0.006,
} as const;

/** Pure so it is testable without a WebGL context. */
export function poseToRotation(
  motion: { yaw: number; pitch: number; roll: number },
  body: { sway: number; breath: number },
  speechEnergy: number
): { x: number; y: number; z: number; lift: number } {
  return {
    y: motion.yaw * POSE_SCALE.yawRad,
    x: motion.pitch * POSE_SCALE.pitchRad + speechEnergy * 0.018,
    z: motion.roll * POSE_SCALE.rollRad + body.sway * POSE_SCALE.swayRad,
    lift: body.breath * POSE_SCALE.breathRise,
  };
}

const LEFT_UPPER = [159, 158, 157, 173];
const LEFT_LOWER = [145, 153, 154, 155];
const RIGHT_UPPER = [386, 385, 384, 398];
const RIGHT_LOWER = [374, 380, 381, 382];
const WEIGHT_KEYS: (keyof BlendWeights)[] = [
  "jawOpen",
  "mouthClose",
  "mouthPucker",
  "mouthFunnel",
  "mouthStretch",
  "mouthSmile",
];

function smoothstep(value: number): number {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-6) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function makeMouthTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.beginPath();
  ctx.ellipse(128, 64, 118, 54, 0, 0, Math.PI * 2);
  ctx.clip();
  const cavity = ctx.createLinearGradient(0, 12, 0, 116);
  cavity.addColorStop(0, "#371619");
  cavity.addColorStop(0.58, "#18080b");
  cavity.addColorStop(1, "#41151c");
  ctx.fillStyle = cavity;
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = "rgba(252, 246, 235, 0.96)";
  ctx.beginPath();
  ctx.ellipse(128, 20, 102, 28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(153, 55, 67, 0.9)";
  ctx.beginPath();
  ctx.ellipse(128, 116, 86, 36, 0, 0, Math.PI * 2);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function loadTexture(loader: THREE.TextureLoader, url: string): Promise<THREE.Texture> {
  return loader.loadAsync(url).then((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
  });
}

export class PhotoFaceHDEngine implements SpeechPlayer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly head = new THREE.Group();
  private readonly faceGeometry: THREE.BufferGeometry;
  private readonly facePositions: Float32Array;
  private readonly basePositions: Float32Array;
  private readonly mouthPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly textures: THREE.Texture[];
  private readonly mouthSet: Set<number>;
  private readonly mouthCenter: THREE.Vector3;
  private readonly mouthWidth: number;
  private readonly mouthHeight: number;
  private readonly faceWidth: number;
  private readonly faceHeight: number;
  private readonly localPoints: THREE.Vector3[];
  private readonly rig: Rig;

  private frame = 0;
  private lastFrame = performance.now();
  private destroyed = false;
  private cues: Cue[] = [];
  private cueStart = 0;
  private speaking = false;
  private audio: HTMLAudioElement | null = null;
  private onAudioEnd: (() => void) | null = null;
  private weights: BlendWeights = { ...ZERO_WEIGHTS };
  private nextBlinkAt = performance.now() + 1800 + Math.random() * 2600;
  private blinkStartedAt = 0;
  // The stable engine's motion drivers, reused as-is (one-way import).
  private readonly headMotion = new HeadMotion();
  private readonly bodyMotion = new BodyMotion();
  private readonly baseHeadY: number;

  static async load(canvas: HTMLCanvasElement, source: PhotoFaceHDSource): Promise<PhotoFaceHDEngine> {
    const rigResponse = await fetch(source.rigUrl);
    if (!rigResponse.ok) throw new Error("Could not load this avatar's face rig");
    const rig = (await rigResponse.json()) as Rig;

    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    const urls = [
      source.imageUrl,
      source.layerUrls?.background,
      source.layerUrls?.body,
      source.layerUrls?.head,
    ];
    const loaded = await Promise.all(
      urls.map((url) => (url ? loadTexture(loader, url) : Promise.resolve(null)))
    );
    return new PhotoFaceHDEngine(canvas, rig, loaded[0]!, {
      background: loaded[1],
      body: loaded[2],
      head: loaded[3],
    }, source.depthZ ?? null);
  }

  private constructor(
    canvas: HTMLCanvasElement,
    rig: Rig,
    image: THREE.Texture,
    layers: { background: THREE.Texture | null; body: THREE.Texture | null; head: THREE.Texture | null },
    depthZ: number[] | null = null
  ) {
    this.rig = rig;
    this.textures = [image, layers.background, layers.body, layers.head].filter(
      (texture): texture is THREE.Texture => texture !== null
    );
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    const renderSize = 640;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // Use a stable logical size. Reading canvas.width here is unsafe because
    // WebGLRenderer writes the DPR-scaled backing size back to that attribute;
    // React StrictMode/HMR would otherwise double it on every remount.
    this.renderer.setSize(renderSize, renderSize, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    const canvasAspect = 1;
    this.camera = new THREE.PerspectiveCamera(30, canvasAspect, 0.1, 20);
    this.camera.position.z = 4.4;
    this.scene.add(this.camera);

    const [imageWidth, imageHeight] = rig.image_size;
    const imageAspect = imageWidth / imageHeight;
    const worldHeight = 2;
    const worldWidth = worldHeight * imageAspect;
    const [x0, y0, x1, y1] = rig.face_box;
    const faceCenterX = ((x0 + x1) / 2 / imageWidth - 0.5) * worldWidth;
    const faceCenterY = (0.5 - (y0 + y1) / 2 / imageHeight) * worldHeight;
    this.faceWidth = ((x1 - x0) / imageWidth) * worldWidth;
    this.faceHeight = ((y1 - y0) / imageHeight) * worldHeight;
    this.head.position.set(faceCenterX, faceCenterY, 0);
    this.baseHeadY = faceCenterY;
    this.scene.add(this.head);

    const makePlane = (texture: THREE.Texture, z: number, parent: THREE.Object3D, transparent: boolean) => {
      const geometry = new THREE.PlaneGeometry(worldWidth, worldHeight);
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent,
        depthWrite: !transparent,
        side: THREE.DoubleSide,
      });
      const plane = new THREE.Mesh(geometry, material);
      plane.position.set(-parent.position.x, -parent.position.y, z);
      parent.add(plane);
    };

    if (layers.background) makePlane(layers.background, -0.16, this.scene, false);
    if (layers.body) makePlane(layers.body, -0.1, this.scene, true);
    if (!layers.background && !layers.body) makePlane(image, -0.12, this.scene, false);
    if (layers.head) makePlane(layers.head, 0, this.head, true);

    const depthAt = (px: number, py: number): number => {
      const nx = (px - (x0 + x1) / 2) / Math.max((x1 - x0) * 0.58, 1);
      const ny = (py - (y0 + y1) / 2) / Math.max((y1 - y0) * 0.68, 1);
      const dome = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const noseX = rig.points[1]?.[0] ?? (x0 + x1) / 2;
      const noseY = rig.points[1]?.[1] ?? (y0 + y1) / 2;
      const noseDistance =
        ((px - noseX) / Math.max((x1 - x0) * 0.22, 1)) ** 2 +
        ((py - noseY) / Math.max((y1 - y0) * 0.25, 1)) ** 2;
      return 0.035 + dome * this.faceWidth * 0.18 + Math.exp(-noseDistance * 2.2) * this.faceWidth * 0.08;
    };

    // MEASURED depth when the lab endpoint supplied it, dome as fallback.
    // MediaPipe z is negative toward the camera and scaled roughly like x,
    // so it converts to world units with the same width ratio the x axis
    // uses. The relief is normalised around its own median rather than used
    // raw: absolute z from a single image is arbitrary, only the shape of
    // the surface is trustworthy.
    let measured: ((index: number) => number) | null = null;
    if (depthZ && depthZ.length === rig.points.length) {
      const sorted = [...depthZ].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const scale = worldWidth / imageWidth;
      measured = (index: number) => 0.035 + Math.max(0, (median - depthZ[index]) * scale * 1.35);
    }

    this.localPoints = rig.points.map(([px, py], index) =>
      new THREE.Vector3(
        (px / imageWidth - 0.5) * worldWidth - faceCenterX,
        (0.5 - py / imageHeight) * worldHeight - faceCenterY,
        measured ? measured(index) : depthAt(px, py)
      )
    );
    this.facePositions = new Float32Array(this.localPoints.length * 3);
    this.localPoints.forEach((point, index) => point.toArray(this.facePositions, index * 3));
    this.basePositions = this.facePositions.slice();

    this.faceGeometry = new THREE.BufferGeometry();
    this.faceGeometry.setAttribute("position", new THREE.BufferAttribute(this.facePositions, 3));
    this.faceGeometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute(
        rig.points.flatMap(([px, py]) => [px / imageWidth, 1 - py / imageHeight]),
        2
      )
    );
    const innerPolygon = rig.inner_lip_ring.map((index) => rig.points[index]);
    const faceIndices = rig.triangles
      .filter(([a, b, c]) => {
        if (innerPolygon.length < 3) return true;
        const cx = (rig.points[a][0] + rig.points[b][0] + rig.points[c][0]) / 3;
        const cy = (rig.points[a][1] + rig.points[b][1] + rig.points[c][1]) / 3;
        return !pointInPolygon(cx, cy, innerPolygon);
      })
      .flat();
    this.faceGeometry.setIndex(faceIndices);
    this.faceGeometry.computeVertexNormals();
    const faceMaterial = new THREE.MeshBasicMaterial({ map: image, side: THREE.DoubleSide });
    const face = new THREE.Mesh(this.faceGeometry, faceMaterial);
    face.position.z = 0.006;
    this.head.add(face);

    this.mouthSet = new Set(rig.mouth_indices);
    const mouthPoints = rig.mouth_indices.map((index) => this.localPoints[index]);
    this.mouthCenter = mouthPoints
      .reduce((sum, point) => sum.add(point), new THREE.Vector3())
      .multiplyScalar(1 / Math.max(mouthPoints.length, 1));
    const mouthXs = mouthPoints.map((point) => point.x);
    const mouthYs = mouthPoints.map((point) => point.y);
    this.mouthWidth = Math.max(...mouthXs) - Math.min(...mouthXs);
    this.mouthHeight = Math.max(Math.max(...mouthYs) - Math.min(...mouthYs), this.faceHeight * 0.025);
    const mouthMaterial = new THREE.MeshBasicMaterial({
      map: makeMouthTexture(),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.textures.push(mouthMaterial.map!);
    this.mouthPlane = new THREE.Mesh(new THREE.PlaneGeometry(this.mouthWidth * 0.95, this.mouthHeight), mouthMaterial);
    this.mouthPlane.position.copy(this.mouthCenter);
    this.mouthPlane.position.z -= 0.004;
    this.mouthPlane.scale.y = 0.08;
    this.head.add(this.mouthPlane);

    this.loop = this.loop.bind(this);
    this.frame = requestAnimationFrame(this.loop);
  }

  playAudio(audioB64: string, mime: string, cues: Cue[], onEnd?: () => void): void {
    this.stopAudio();
    const audio = new Audio(`data:${mime};base64,${audioB64}`);
    this.audio = audio;
    this.onAudioEnd = onEnd ?? null;
    this.cues = prepareCues(cues);
    this.speaking = true;
    this.cueStart = performance.now();
    audio.addEventListener("ended", () => {
      if (this.audio === audio) this.finishSpeech();
    });
    audio.addEventListener("error", () => {
      if (this.audio === audio) this.finishSpeech();
    });
    void audio.play().catch(() => {
      if (this.audio === audio) this.finishSpeech();
    });
  }

  playCues(cues: Cue[]): void {
    this.stopAudio();
    this.cues = prepareCues(cues);
    this.speaking = true;
    this.cueStart = performance.now();
  }

  syncCueTime(ms: number): void {
    this.cueStart = performance.now() - ms;
  }

  stopSpeech(): void {
    const callback = this.onAudioEnd;
    this.onAudioEnd = null;
    this.stopAudio();
    this.speaking = false;
    this.cues = [];
    this.weights = { ...ZERO_WEIGHTS };
    callback?.();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.stopSpeech();
    this.faceGeometry.dispose();
    this.mouthPlane.geometry.dispose();
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
      if (object.geometry !== this.faceGeometry && object.geometry !== this.mouthPlane.geometry) {
        object.geometry.dispose();
      }
    });
    this.textures.forEach((texture) => texture.dispose());
    this.renderer.dispose();
  }

  private stopAudio(): void {
    if (!this.audio) return;
    const audio = this.audio;
    this.audio = null;
    audio.pause();
    audio.src = "";
  }

  private finishSpeech(): void {
    this.speaking = false;
    this.cues = [];
    this.weights = { ...ZERO_WEIGHTS };
    this.audio = null;
    const callback = this.onAudioEnd;
    this.onAudioEnd = null;
    callback?.();
  }

  private targetWeights(now: number): BlendWeights {
    if (!this.speaking || !this.cues.length) return { ...ZERO_WEIGHTS };
    const elapsed = now - this.cueStart;
    let index = 0;
    while (index + 1 < this.cues.length && this.cues[index + 1].t <= elapsed) index++;
    const current = this.cues[index];
    const next = this.cues[Math.min(index + 1, this.cues.length - 1)];
    const span = Math.max(1, next.t - current.t);
    const mix = next === current ? 0 : smoothstep((elapsed - current.t) / span);
    const currentShape = this.rig.visemes[current.viseme] ?? {};
    const nextShape = this.rig.visemes[next.viseme] ?? {};
    const output = { ...ZERO_WEIGHTS };
    for (const key of WEIGHT_KEYS) {
      const from = (currentShape[key] ?? 0) * (current.a ?? 1);
      const to = (nextShape[key] ?? 0) * (next.a ?? 1);
      output[key] = from + (to - from) * mix;
    }
    return output;
  }

  private blinkAmount(now: number): number {
    if (!this.blinkStartedAt && now >= this.nextBlinkAt) this.blinkStartedAt = now;
    if (!this.blinkStartedAt) return 0;
    const phase = (now - this.blinkStartedAt) / 170;
    if (phase >= 1) {
      this.blinkStartedAt = 0;
      this.nextBlinkAt = now + 2500 + Math.random() * 4200;
      return 0;
    }
    return phase < 0.42 ? smoothstep(phase / 0.42) : 1 - smoothstep((phase - 0.42) / 0.58);
  }

  private updateFace(now: number, dt: number): void {
    const target = this.targetWeights(now);
    const follow = 1 - Math.exp(-dt / 70);
    for (const key of WEIGHT_KEYS) this.weights[key] += (target[key] - this.weights[key]) * follow;

    this.facePositions.set(this.basePositions);
    const w = this.weights;
    const mouthRadiusX = Math.max(this.mouthWidth * 0.9, 0.01);
    const mouthRadiusY = Math.max(this.faceHeight * 0.32, 0.01);

    for (let index = 0; index < this.localPoints.length; index++) {
      const offset = index * 3;
      const baseX = this.basePositions[offset];
      const baseY = this.basePositions[offset + 1];
      const baseZ = this.basePositions[offset + 2];
      const dx = baseX - this.mouthCenter.x;
      const dy = baseY - this.mouthCenter.y;
      const distance = (dx / mouthRadiusX) ** 2 + (dy / mouthRadiusY) ** 2;
      const influence = Math.exp(-distance * 2.4);
      const isMouth = this.mouthSet.has(index);
      const lower = baseY < this.mouthCenter.y ? 1 : 0;
      const lipInfluence = isMouth ? 1 : influence;

      let x = baseX;
      let y = baseY;
      let z = baseZ;
      y -= w.jawOpen * this.faceHeight * 0.038 * influence * (0.35 + lower * 0.65);
      if (isMouth) {
        const lipSide = lower ? -1 : 1;
        y += lipSide * w.jawOpen * this.faceHeight * 0.018;
        y += (this.mouthCenter.y - y) * w.mouthClose * 0.82;
        x += dx * w.mouthStretch * 0.23;
        x -= dx * (w.mouthPucker * 0.32 + w.mouthFunnel * 0.18);
        const corner = Math.min(1, Math.abs(dx) / Math.max(this.mouthWidth * 0.42, 0.01));
        y += w.mouthSmile * this.faceHeight * 0.018 * corner;
        z += (w.mouthPucker * 0.05 + w.mouthFunnel * 0.025) * this.faceWidth;
      } else {
        x += dx * w.mouthStretch * 0.035 * lipInfluence;
      }
      this.facePositions[offset] = x;
      this.facePositions[offset + 1] = y;
      this.facePositions[offset + 2] = z;
    }

    const blink = this.blinkAmount(now);
    const closeLids = (uppers: number[], lowers: number[]) => {
      uppers.forEach((upper, pair) => {
        const lower = lowers[pair];
        if (upper >= this.localPoints.length || lower >= this.localPoints.length) return;
        const upperOffset = upper * 3;
        const lowerOffset = lower * 3;
        this.facePositions[upperOffset + 1] +=
          (this.basePositions[lowerOffset + 1] - this.basePositions[upperOffset + 1]) * blink * 0.82;
      });
    };
    closeLids(LEFT_UPPER, LEFT_LOWER);
    closeLids(RIGHT_UPPER, RIGHT_LOWER);

    const attribute = this.faceGeometry.getAttribute("position") as THREE.BufferAttribute;
    attribute.needsUpdate = true;
    this.faceGeometry.computeVertexNormals();
    this.mouthPlane.scale.y = 0.08 + w.jawOpen * 1.45 + w.mouthFunnel * 0.35;
    this.mouthPlane.scale.x = 1 + w.mouthStretch * 0.18 - w.mouthPucker * 0.22;
    this.mouthPlane.visible = w.jawOpen > 0.025 || w.mouthFunnel > 0.08;
  }

  private loop(now: number): void {
    if (this.destroyed) return;
    const dt = Math.min(50, now - this.lastFrame);
    this.lastFrame = now;
    this.updateFace(now, dt);

    this.headMotion.update(dt, now, this.speaking);
    this.bodyMotion.update(dt, now);
    const pose = poseToRotation(this.headMotion, this.bodyMotion, this.weights.jawOpen * 0.45);
    this.head.rotation.x = pose.x;
    this.head.rotation.y = pose.y;
    this.head.rotation.z = pose.z;
    this.head.position.y = this.baseHeadY + pose.lift;
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.loop);
  }
}
