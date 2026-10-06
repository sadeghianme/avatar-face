/**
 * A photograph of teeth and the rig that says where its mouth is: what a
 * continuous mouth draws its teeth from (dental-oral-surface.ts), checked
 * before anything is drawn from it.
 */
import type { Rig } from "../types";

export interface OralPhoto {
  image: HTMLImageElement;
  rig: Pick<Rig, "points" | "image_size" | "inner_lip_ring" | "outer_lip_ring">;
}

export function validateOralRig(value: unknown): OralPhoto["rig"] {
  const rig = value as OralPhoto["rig"] | null;
  if (
    !rig ||
    !Array.isArray(rig.points) ||
    rig.points.length !== 478 ||
    !rig.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) ||
    !Array.isArray(rig.image_size) ||
    rig.image_size.length !== 2 ||
    !rig.image_size.every((n) => Number.isFinite(n) && n > 0) ||
    ![rig.inner_lip_ring, rig.outer_lip_ring].every(
      (r) =>
        Array.isArray(r) &&
        r.length === 20 &&
        new Set(r).size === 20 &&
        r.every((i) => Number.isInteger(i) && i >= 0 && i < 478)
    ) ||
    Math.hypot(rig.points[291][0] - rig.points[61][0], rig.points[291][1] - rig.points[61][1]) < 2
  ) {
    throw new Error("Invalid mouth photograph rig");
  }
  return rig;
}
