/**
 * What the picture looks like, read from its texture: the lips' and the
 * skin's colours, the brightest skin, how sharp the picture is, each eye's
 * lash colour and lid, the character look, and whether it is a cut-out.
 *
 * Every reading survives a texture it cannot read (a cross-origin picture
 * taints the canvas and getImageData throws): it keeps what it had, which
 * is the default until a readable texture has been seen.
 */
import { eyeExtent, lidSamplePoints, medianColour, type LidTone } from "./blink-lid";
import { DEFAULT_LOOK, INNER_UPPER, sampleLook, type CharacterLook, type Rgb } from "./character-mouth";
import { FACE_OVAL, faceHighlight } from "./face-light";
import { faceSharpness, lumaField, sharpnessBoxes } from "./face-sharpness";
import type { KindProfile } from "./kind-profile";
import type { Rig } from "../types";
import type { Point } from "./geometry";
import { CHEEK_LANDMARKS, UPPER_LIDS, eyeShape } from "./landmarks";

export interface Sample {
  lum: number;
  rgb: [number, number, number];
}

export function luma(rgb: [number, number, number]): number {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

function chroma(rgb: [number, number, number]): number {
  return Math.max(...rgb) - Math.min(...rgb);
}

// A sclera's colour cast is a fraction of the surrounding skin's, and it is
// never much darker than that skin. Tuned so a cartoon eye with no white at
// all is rejected while real sclera under warm light still passes.
const MAX_SCLERA_CHROMA_VS_SKIN = 0.45;
const MIN_SCLERA_LUMA_VS_SKIN = 0.75;

/**
 * Pick the sclera colour out of samples taken beside the iris, or null if none
 * of them is plausibly an eye white.
 *
 * Getting this wrong is what made the eyes change when the avatar looked
 * around: the old version took the 85th brightness percentile of everything
 * inside the eye-opening polygon, which on a real avatar returned
 * rgb(174,156,142) — beige skin — and then painted it inside the eye.
 *
 * A sclera is the brightest NEUTRAL thing in an eye. Both halves matter and
 * neither works alone: skin is bright but strongly chromatic, while lash,
 * liner and pupil are neutral but dark. So the test is relative to the skin
 * just below the eye, which also handles exposure and skin tone — on a dark
 * face the sclera is far brighter than the cheek, on a pale one it is about
 * equal, but in both the sclera is markedly less chromatic.
 *
 * The thresholds are deliberately biased toward rejection. A false negative
 * costs gaze on one eye, which nobody notices. A false positive paints skin
 * colour inside an eyeball, which is the bug this replaces.
 */
export function pickScleraColour(candidates: Sample[], skin: Sample | null): string | null {
  if (!candidates.length) return null;
  const brightestFirst = [...candidates].sort((a, b) => b.lum - a.lum);
  const skinChroma = skin ? chroma(skin.rgb) : 40;
  const maxChroma = Math.max(6, skinChroma * MAX_SCLERA_CHROMA_VS_SKIN);
  const minLum = skin ? skin.lum * MIN_SCLERA_LUMA_VS_SKIN : 120;
  const found = brightestFirst.find((s) => chroma(s.rgb) <= maxChroma && s.lum >= minLum);
  return found ? `rgb(${found.rgb.join(", ")})` : null;
}

/** The texture drawn 1:1 into a canvas that can be read back, or null. */
function readable(texture: HTMLImageElement): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement("canvas");
  canvas.width = texture.naturalWidth;
  canvas.height = texture.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(texture, 0, 0);
  return { canvas, ctx };
}

/**
 * Does this photo have its background removed?
 *
 * Decides how far the body is allowed to move. Checked by sampling the
 * corners rather than by asking the server, so the engine stays usable with
 * any image and a cut-out made elsewhere still gets the full treatment.
 * Several corners, because one of them can legitimately be part of the
 * subject — a shoulder often reaches the bottom edge.
 *
 * Null when no canvas could be had to look (the caller keeps what it knew).
 */
export function probeCutOut(texture: HTMLImageElement): boolean | null {
  try {
    const probe = document.createElement("canvas");
    probe.width = 32;
    probe.height = 32;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(texture, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    const at = (x: number, y: number) => data[(y * 32 + x) * 4 + 3];
    const corners = [at(1, 1), at(30, 1), at(1, 30), at(30, 30)];
    // Two clear corners is enough, and is what a head-and-shoulders cut-out
    // reliably has at the top even when the body fills the bottom.
    return corners.filter((a) => a < 24).length >= 2;
  } catch {
    // Tainted canvas (cross-origin texture): assume it is not a cut-out,
    // which is the conservative choice — less movement, never a stray edge.
    return false;
  }
}

/** Everything read from the texture, as the painters and the mouth use it. */
export class FaceSamples {
  /** The face's own lip colour, sampled at load. The mouth interior is
   * derived from it rather than hardcoded. */
  lipColour: [number, number, number] = [150, 90, 84];
  /** Mid-cheek skin, sampled with the lips: the scene's exposure and colour
   *  cast, which a mouth renderer needs to light anything it draws. */
  skinColour: [number, number, number] | null = null;
  /** Luma of the picture's brightest skin or sclera (face-light.ts): the
   *  ceiling for the teeth a mouth renderer draws into it. */
  faceHighlight: number | null = null;
  /** The width of the picture's crispest edges, texture px (face-sharpness.ts);
   *  null on a flat or tainted picture. */
  faceSharpness: number | null = null;
  /** Each eye's own lash colour. Not every face has black lashes — a fair or
   * stylized one can have brown, auburn or near-white, and drawing black on
   * those puts a stranger's eyelash on the face. */
  lashColour: string[] = ["rgba(60, 42, 38, 0.75)", "rgba(60, 42, 38, 0.75)"];
  /** The same, as numbers, and each eye's lid colour: for the painted lid
   *  of a profile that blinks that way (blink-lid.ts). */
  lashRgb: Rgb[] = [
    [60, 42, 38],
    [60, 42, 38],
  ];
  /** Each eye's real reach in texture pixels (blink-lid.ts eyeExtent), and
   *  whether the skin below it is plain enough to copy for a lid. */
  lidExtent: (Point[] | null)[] = [null, null];
  lidCloneOk: boolean[] = [false, false];
  lidTone: LidTone[] = [
    { above: [200, 150, 130], below: [200, 150, 130] },
    { above: [200, 150, 130], below: [200, 150, 130] },
  ];
  /** Cel art or a render, its line and its softness, for the character
   *  mouth to paint in (and the mesh to pad its seams on flat art). */
  look: CharacterLook = DEFAULT_LOOK;

  /**
   * Read it all from `texture`, whose landmarks are at `texPoints` (over
   * the texture's own size). The order matters: the character look takes
   * its softness from the sharpness, which is read with the lips.
   *
   * What a texture that cannot be read leaves is the last texture's: its
   * colours hold for a copy of the same picture, but its sharpness was a
   * width in that texture's pixels, so it is dropped first.
   */
  sample(texture: HTMLImageElement, texPoints: readonly Point[], rig: Rig, profile: KindProfile): void {
    this.faceSharpness = null;
    this.sampleLipColour(texture, texPoints, rig.mouth_indices);
    this.sampleLashColour(texture, texPoints);
    this.sampleCharacterLook(texture, texPoints);
    if (profile.blink === "lid") this.sampleLidColours(texture, texPoints);
  }

  /**
   * The lip's own colour, taken from the outer lip ring.
   *
   * The mouth interior used to be three hardcoded browns near black. On a
   * pale face that is a hole punched in the skin, and it is the same hole on
   * every avatar regardless of colouring. A real mouth interior is a darker,
   * less saturated version of the lips in front of it, so sampling the lips
   * gives every face an interior that belongs to it.
   */
  private sampleLipColour(texture: HTMLImageElement, texPoints: readonly Point[], mouth: readonly number[]): void {
    try {
      const page = readable(texture);
      if (!page) return;
      const { canvas: off, ctx } = page;
      const picks: { lum: number; rgb: [number, number, number] }[] = [];
      for (const i of mouth) {
        const p = texPoints[i];
        if (!p) continue;
        const x = Math.max(0, Math.min(off.width - 1, Math.round(p.x)));
        const y = Math.max(0, Math.min(off.height - 1, Math.round(p.y)));
        const d = ctx.getImageData(x, y, 1, 1).data;
        const rgb: [number, number, number] = [d[0], d[1], d[2]];
        picks.push({ lum: luma(rgb), rgb });
      }
      if (!picks.length) return;
      // Median: the ring straddles the lip edge, so the extremes are skin on
      // one side and the seam shadow on the other.
      picks.sort((a, b) => a.lum - b.lum);
      this.lipColour = picks[Math.floor(picks.length / 2)].rgb;

      // Cheeks, not lips, say how the face is lit: lips are darker and far
      // more saturated than the light falling on them (lipstick more so), so
      // teeth exposed from lip luminance came out grey on a bright face.
      const skin: { lum: number; rgb: [number, number, number] }[] = [];
      for (const i of CHEEK_LANDMARKS) {
        const q = texPoints[i];
        if (!q) continue;
        const sx = Math.max(0, Math.min(off.width - 1, Math.round(q.x)));
        const sy = Math.max(0, Math.min(off.height - 1, Math.round(q.y)));
        const c = ctx.getImageData(sx, sy, 1, 1).data;
        const rgb: [number, number, number] = [c[0], c[1], c[2]];
        skin.push({ lum: luma(rgb), rgb });
      }
      if (skin.length) {
        skin.sort((a, b) => a.lum - b.lum);
        this.skinColour = skin[Math.floor(skin.length / 2)].rgb;
      }
      this.sampleFaceHighlight(texture, texPoints);
      this.sampleFaceSharpness(ctx, texture, texPoints);
    } catch {
      // Tainted texture: keep the default, which is a mid warm lip.
    }
  }

  /**
   * How sharp the picture is (face-sharpness.ts): the width of its crispest
   * strong edges round the mouth and the eyes, in its own pixels, read
   * from `ctx`, which holds the texture 1:1 (no filtering: the widths are
   * the picture's). The photographic mouth feathers its aperture by it and
   * softens the teeth to it; the character mouth's look takes its softness
   * from it (sampleCharacterLook, which runs after this). Null on a flat
   * picture; `sample` clears it first, so a texture that cannot be read
   * leaves no stale value from the one before it.
   */
  private sampleFaceSharpness(
    ctx: CanvasRenderingContext2D,
    texture: HTMLImageElement,
    texPoints: readonly Point[]
  ): void {
    const fields = sharpnessBoxes(texPoints, texture.naturalWidth, texture.naturalHeight).map((b) => {
      const d = ctx.getImageData(b.x, b.y, b.w, b.h);
      return lumaField(d.data, d.width, d.height);
    });
    this.faceSharpness = faceSharpness(fields);
  }

  /**
   * The face's brightest skin or sclera, from a small box-filtered copy of
   * its silhouette's box: one draw and one read, so a glint of a pixel or
   * two cannot set it, and nothing outside the face oval (hair, a collar, a
   * white wall) counts.
   */
  private sampleFaceHighlight(texture: HTMLImageElement, texPoints: readonly Point[]): void {
    const oval = FACE_OVAL.map((i) => texPoints[i]).filter(Boolean);
    if (oval.length < 8) return;
    const x0 = Math.min(...oval.map((p) => p.x)),
      x1 = Math.max(...oval.map((p) => p.x));
    const y0 = Math.min(...oval.map((p) => p.y)),
      y1 = Math.max(...oval.map((p) => p.y));
    if (!(x1 > x0) || !(y1 > y0)) return;
    const grid = 96;
    const small = document.createElement("canvas");
    small.width = grid;
    small.height = grid;
    const ctx = small.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(texture, x0, y0, x1 - x0, y1 - y0, 0, 0, grid, grid);
    const data = ctx.getImageData(0, 0, grid, grid).data;
    this.faceHighlight = faceHighlight(
      oval,
      (column, row) => {
        const i = (row * grid + column) * 4;
        return data[i + 3] < 128 ? null : [data[i], data[i + 1], data[i + 2]];
      },
      grid
    );
  }

  /** Each eye's lid colour, from the skin beside it, for the painted lid. */
  private sampleLidColours(texture: HTMLImageElement, texPoints: readonly Point[]): void {
    try {
      const page = readable(texture);
      if (!page) return;
      const { canvas: off, ctx } = page;
      for (let e = 0; e < 2; e++) {
        const shape = eyeShape(texPoints, e);
        const read = (p: Point): Rgb | null => {
          const x = Math.round(p.x),
            y = Math.round(p.y);
          if (x < 0 || y < 0 || x >= off.width || y >= off.height) return null;
          const d = ctx.getImageData(x, y, 1, 1).data;
          return d[3] < 128 ? null : [d[0], d[1], d[2]];
        };
        const spots = lidSamplePoints(shape.upper, shape.lower);
        const nUp = shape.upper.length - 2;
        const readUp = spots.slice(0, nUp).map(read);
        const readDown = spots.slice(nUp).map(read);
        // A brow or a lash line can sit where "above the eye" is read, and it
        // is dark: the lid's own skin is the lighter end of what both sides
        // give, and the skin above is read from them together.
        const below = medianColour(readDown, 0.65);
        const above = medianColour([...readUp, ...readDown], 0.65);
        const either = above ?? below;
        if (either) this.lidTone[e] = { above: above ?? either, below: below ?? either };
        // How far the eye really reaches, and whether the skin below is plain.
        const w = Math.hypot(
          shape.upper[shape.upper.length - 1].x - shape.upper[0].x,
          shape.upper[shape.upper.length - 1].y - shape.upper[0].y
        );
        const all = [...shape.upper, ...shape.lower];
        const rx0 = Math.max(0, Math.floor(Math.min(...all.map((q) => q.x)) - w * 1.1));
        const ry0 = Math.max(0, Math.floor(Math.min(...all.map((q) => q.y)) - w * 1.1));
        const rx1 = Math.min(off.width, Math.ceil(Math.max(...all.map((q) => q.x)) + w * 1.1));
        const ry1 = Math.min(off.height, Math.ceil(Math.max(...all.map((q) => q.y)) + w * 1.1));
        if (rx1 > rx0 && ry1 > ry0 && either) {
          const img = ctx.getImageData(rx0, ry0, rx1 - rx0, ry1 - ry0);
          const at = (x: number, y: number): Rgb | null => {
            const px = Math.round(x) - rx0,
              py = Math.round(y) - ry0;
            if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
            const i = (py * img.width + px) * 4;
            return img.data[i + 3] < 128 ? null : [img.data[i], img.data[i + 1], img.data[i + 2]];
          };
          // How much the skin's own texture varies: fur and pores are noise the
          // eye's edge must stand out from, flat art has none.
          const around = [...readUp, ...readDown].filter((c): c is Rgb => !!c);
          const ref = either;
          const spread = around.length
            ? Math.sqrt(
                around.reduce((sum, c) => sum + (c[0] - ref[0]) ** 2 + (c[1] - ref[1]) ** 2 + (c[2] - ref[2]) ** 2, 0) /
                  around.length
              )
            : 0;
          this.lidExtent[e] = eyeExtent(at, shape, Math.max(50, Math.min(95, spread * 2.5)));
          // The patch the lid would copy: the skin below the eye. It must be one
          // surface (fur, skin), not an outline or another shape.
          const bottom = Math.max(...shape.lower.map((q) => q.y));
          const left = Math.min(...all.map((q) => q.x));
          let far = 0,
            n = 0;
          for (let a = 0; a < 10; a++) {
            for (let b = 0; b < 5; b++) {
              const c = at(left + (w * (a + 0.5)) / 10, bottom + w * (0.08 + 0.1 * b));
              if (!c) continue;
              n++;
              const ref = below ?? either;
              if (Math.hypot(c[0] - ref[0], c[1] - ref[1], c[2] - ref[2]) > Math.max(70, spread * 3)) far++;
            }
          }
          this.lidCloneOk[e] = n > 0 && far / n <= 0.18;
        }
      }
    } catch {
      // Tainted texture: the default skin tone.
    }
  }

  /**
   * Cel art or a render, the picture's own line and how soft its edges are,
   * for the character mouth to paint in. The softness is the picture's
   * sharpness (`faceSharpness`, read by sampleLipColour, which always runs
   * before this: in the constructor and again in setTexture, so a texture
   * upgraded from its thumbnail rebuilds the look from its own sharpness);
   * the lip seam is read for it only when the sharpness is null.
   */
  private sampleCharacterLook(texture: HTMLImageElement, texPoints: readonly Point[]): void {
    // For every profile: the character mouth paints with it, and the mesh
    // pads its seams on flat art whichever mouth it has (MeshWarp.trianglePads).
    const skin: Rgb = this.skinColour ?? DEFAULT_LOOK.skin;
    this.look = { ...DEFAULT_LOOK, lip: this.lipColour, skin };
    try {
      const l = texPoints[61],
        r = texPoints[291];
      if (!l || !r) return;
      const w = Math.max(Math.hypot(r.x - l.x, r.y - l.y), 4);
      const cx = (l.x + r.x) / 2,
        cy = (l.y + r.y) / 2;
      const x0 = Math.max(0, Math.floor(cx - w * 2)),
        y0 = Math.max(0, Math.floor(cy - w * 1.2));
      const x1 = Math.min(texture.naturalWidth, Math.ceil(cx + w * 2));
      const y1 = Math.min(texture.naturalHeight, Math.ceil(cy + w * 1.7));
      if (x1 <= x0 || y1 <= y0) return;
      const page = readable(texture);
      if (!page) return;
      const data = page.ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      const pixel = (x: number, y: number): Rgb | null => {
        const px = Math.round(x) - x0,
          py = Math.round(y) - y0;
        if (px < 0 || py < 0 || px >= data.width || py >= data.height) return null;
        const i = (py * data.width + px) * 4;
        if (data.data[i + 3] < 128) return null;
        return [data.data[i], data.data[i + 1], data.data[i + 2]];
      };
      const seam = INNER_UPPER.map((i) => texPoints[i]).filter(Boolean);
      this.look = sampleLook(pixel, seam, { cx, cy, w }, this.lipColour, skin, this.faceSharpness);
    } catch {
      // Tainted texture: the default look, shaded.
    }
  }

  /** The darkest run along each upper lid — the lashes as this face has them. */
  private sampleLashColour(texture: HTMLImageElement, texPoints: readonly Point[]): void {
    try {
      const page = readable(texture);
      if (!page) return;
      const { canvas: off, ctx } = page;
      for (let e = 0; e < 2; e++) {
        const lid = UPPER_LIDS[e].map((i) => texPoints[i]).filter(Boolean);
        if (lid.length < 3) continue;
        const picks: { lum: number; rgb: [number, number, number] }[] = [];
        for (const p of lid) {
          for (let dy = -1; dy <= 1; dy++) {
            const x = Math.max(0, Math.min(off.width - 1, Math.round(p.x)));
            const y = Math.max(0, Math.min(off.height - 1, Math.round(p.y + dy)));
            const d = ctx.getImageData(x, y, 1, 1).data;
            const rgb: [number, number, number] = [d[0], d[1], d[2]];
            picks.push({ lum: luma(rgb), rgb });
          }
        }
        if (!picks.length) continue;
        // The darkest quartile along the lid IS the lash line, whatever
        // colour this face's lashes happen to be.
        picks.sort((a, b) => a.lum - b.lum);
        const [r, g, b] = picks[Math.floor(picks.length * 0.15)].rgb;
        this.lashColour[e] = `rgba(${r}, ${g}, ${b}, 0.8)`;
        this.lashRgb[e] = [r, g, b];
      }
    } catch {
      // Tainted texture: keep the neutral dark default.
    }
  }
}
