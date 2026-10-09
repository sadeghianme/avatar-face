/**
 * The Photoface HD lab's face surface (photoface-hd.ts): each landmark's
 * depth, the face's triangles, the mouth's texture, and the pictures
 * loaded as textures. Under lab/, on the same one-way contract.
 */
import * as THREE from "three";

import type { Rig } from "../types";

/**
 * Each landmark's depth on the face surface, world units, for a picture
 * `worldWidth` wide and a face `faceWidth` wide in it. MEASURED depth when
 * the lab endpoint supplied it (`depthZ`, MediaPipe's z per landmark), a
 * dome with a nose as the fallback. MediaPipe z is negative toward the
 * camera and scaled roughly like x, so it converts to world units with the
 * same width ratio the x axis uses. The relief is normalised around its own
 * median rather than used raw: absolute z from a single image is arbitrary,
 * only the shape of the surface is trustworthy.
 */
export function surfaceDepth(
  rig: Rig,
  worldWidth: number,
  faceWidth: number,
  depthZ: number[] | null
): (index: number) => number {
  const [imageWidth] = rig.image_size;
  const [x0, y0, x1, y1] = rig.face_box;
  if (depthZ && depthZ.length === rig.points.length) {
    const sorted = [...depthZ].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const scale = worldWidth / imageWidth;
    return (index: number) => 0.035 + Math.max(0, (median - depthZ[index]) * scale * 1.35);
  }
  return (index: number) => {
    const [px, py] = rig.points[index];
    const nx = (px - (x0 + x1) / 2) / Math.max((x1 - x0) * 0.58, 1);
    const ny = (py - (y0 + y1) / 2) / Math.max((y1 - y0) * 0.68, 1);
    const dome = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const noseX = rig.points[1]?.[0] ?? (x0 + x1) / 2;
    const noseY = rig.points[1]?.[1] ?? (y0 + y1) / 2;
    const noseDistance =
      ((px - noseX) / Math.max((x1 - x0) * 0.22, 1)) ** 2 + ((py - noseY) / Math.max((y1 - y0) * 0.25, 1)) ** 2;
    return 0.035 + dome * faceWidth * 0.18 + Math.exp(-noseDistance * 2.2) * faceWidth * 0.08;
  };
}

/** The face's triangles, three indices each, less those inside the inner
 *  lip ring (the mouth plane shows through there). */
export function faceTriangles(rig: Rig): number[] {
  const innerPolygon = rig.inner_lip_ring.map((index) => rig.points[index]);
  return rig.triangles
    .filter(([a, b, c]) => {
      if (innerPolygon.length < 3) return true;
      const cx = (rig.points[a][0] + rig.points[b][0] + rig.points[c][0]) / 3;
      const cy = (rig.points[a][1] + rig.points[b][1] + rig.points[c][1]) / 3;
      return !pointInPolygon(cx, cy, innerPolygon);
    })
    .flat();
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

export function makeMouthTexture(): THREE.CanvasTexture {
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

export function loadTexture(loader: THREE.TextureLoader, url: string): Promise<THREE.Texture> {
  return loader.loadAsync(url).then((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
  });
}
