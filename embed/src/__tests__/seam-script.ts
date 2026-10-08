/**
 * The frames the seam tests draw, wherever they draw them (seams.test.ts
 * on Skia, browser-tests/seams.test.ts in Chromium on the GPU path and the
 * 2D one): the committed human photo, as itself and as a layered avatar
 * (its own picture for a body, and for a head the same picture faded out
 * down the neck, as a published head layer is), its head turned in depth
 * to every corner of the personality's limits, still and mid-sentence.
 * For each frame the mesh's outer boundary on the canvas and what the
 * canvas held just before the mesh was drawn (seam-probe.ts). Nothing in
 * here touches Node or the DOM: the caller provides the canvas reads.
 */
import type { AvatarEngine } from "../engine";
import type { Point } from "../engine/geometry";
import { POSE_LIMIT_DEG } from "../engine/head-personality";
import { engineSeam } from "../engine/seam";
import type { Affine } from "../engine/warp-gl";
import type { Cue, Rig } from "../types";
import { meshBoundary, type Segment } from "./seam-probe";

/** The stage's side: the dashboard preview's scale, at a quarter of the
 *  area (the face is ~300 px across). */
export const SEAM_SIZE = 480;
const STEP = 16;

/** Yaw, pitch and roll in units of the limits: the corners of the pose box
 *  and the turn and nod alone. */
export const SEAM_POSES: readonly [string, number, number, number][] = [
  ["left, down, tilted", -1, 1, -1],
  ["right, up, tilted", 1, -1, 1],
  ["right, down, tilted back", 1, 1, -1],
  ["left, up", -1, -1, 0],
  ["turned right", 1, 0, 0],
  ["nodded down", 0, 1, 0],
];

/**
 * Where a head layer made from the photo fades out, texture px: whole down
 * to a little under the chin, nothing from halfway down the neck. From the
 * rig's chin (152) and face height.
 */
export function headLayerFade(rig: Rig, textureHeight: number): [number, number] {
  const k = textureHeight / rig.image_size[1];
  const ys = rig.points.slice(0, 468).map((p) => p[1]);
  const faceH = Math.max(...ys) - Math.min(...ys);
  const chin = rig.points[152][1];
  return [(chin + 0.05 * faceH) * k, (chin + 0.45 * faceH) * k];
}

/**
 * Hard diagonal stripes over the photo from just under the chin down
 * (texture px, painted with `fill(x, y, w, h, dark)`): a collar's edges,
 * everywhere the neck band's bottom can fall, so that the band drawn a
 * pixel off what is under it steps every stripe (the portrait's own neck
 * is too smooth to show a pixel's slip).
 */
export function paintCollar(
  rig: Rig,
  textureWidth: number,
  textureHeight: number,
  fill: (x: number, y: number, w: number, h: number, dark: boolean) => void
): void {
  const k = textureHeight / rig.image_size[1];
  const ys = rig.points.slice(0, 468).map((p) => p[1]);
  const faceH = Math.max(...ys) - Math.min(...ys);
  const top = Math.round((rig.points[152][1] + 0.12 * faceH) * k);
  const band = Math.max(2, Math.round(textureWidth / 80));
  for (let y = top; y < textureHeight; y++) {
    const shift = Math.floor((y - top) / 2);
    for (let x0 = -band * 2 + (shift % (band * 2)); x0 < textureWidth; x0 += band * 2) fill(x0, y, band, 1, true);
  }
}

export interface SeamFrame {
  name: string;
  /** The frame, and the canvas just before the mesh was drawn, RGBA. */
  frame: Uint8ClampedArray;
  under: Uint8ClampedArray;
  /** The mesh's outer boundary on the canvas. */
  segments: Segment[];
  /** The fold clamp's share of the turn kept (1: all). */
  scale: number;
}

/**
 * The script: settle, each pose held (the personality's own pose for the
 * frame, overridden after its tick), then the hello track with the head
 * turned right and down at 40% through it. `read()` is the engine's canvas
 * now; `clock.now` is the frame time.
 */
export async function playSeamScript(
  engine: AvatarEngine,
  cues: Cue[],
  clock: { now: number },
  read: () => Uint8ClampedArray
): Promise<SeamFrame[]> {
  const e = engineSeam(engine);
  const tick = (n: number) => {
    for (let i = 0; i < n; i++) {
      clock.now += STEP;
      e.tick(clock.now);
    }
  };
  // What each frame drew the mesh over, with and through.
  let under: Uint8ClampedArray | null = null;
  let drawn: { pts: Point[]; affine: Affine } | null = null;
  const warp = e.meshWarp;
  const draw = warp.draw.bind(warp);
  warp.draw = (ctx, pts, affine) => {
    under = read();
    drawn = { pts: pts.map((p) => ({ ...p })), affine: { ...affine } };
    draw(ctx, pts, affine);
  };
  const DEG = Math.PI / 180;
  const pose = (yaw: number, pitch: number, roll: number) => {
    const p = e.motion.personality.pose;
    p.yaw = yaw * POSE_LIMIT_DEG.yaw * DEG;
    p.pitch = pitch * POSE_LIMIT_DEG.pitch * DEG;
    p.roll = roll * POSE_LIMIT_DEG.roll * DEG;
    e.motion.personality.brow = 0;
  };
  const frames: SeamFrame[] = [];
  const capture = (name: string) => {
    under = null;
    drawn = null;
    e.render();
    if (!under || !drawn) throw new Error(`${name}: the mesh was not drawn`);
    const { pts, affine } = drawn as { pts: Point[]; affine: Affine };
    frames.push({
      name,
      frame: read(),
      under,
      segments: meshBoundary(e.mesh, pts, affine),
      scale: engine.headTurnStats()?.scale ?? 1,
    });
  };
  tick(40);
  for (const [name, yaw, pitch, roll] of SEAM_POSES) {
    tick(1);
    pose(yaw, pitch, roll);
    capture(name);
  }
  engine.playCues(cues);
  const start = clock.now;
  const at = Math.round((0.4 * cues[cues.length - 1].t) / STEP) * STEP;
  while (clock.now < start + at) tick(1);
  pose(0.8, 0.6, 0.3);
  capture("speaking, turned");
  engine.stopSpeech();
  warp.draw = draw;
  return frames;
}
