/**
 * The AI expression pictures (docs/emotions.md, "AI expression pictures"):
 * for an avatar whose owner chose them, a photo of its own face making each
 * expression, made by the image model and registered on the face's
 * landmarks (the backend's services.expression_kit). Where one is loaded,
 * the expression's upper face is that picture, not the warp:
 *
 * - the GEOMETRY: under the picture's mask (expression-picture-masks.ts),
 *   each landmark moves toward where the picture has it (`targets`, the
 *   manifest's), by the expression's weight times the mask there; outside
 *   it, the animated expression's own displacement (expression-rig.ts), so
 *   the two meet with no seam and the mouth's corners stay the warp's;
 * - the COLOUR: the picture, masked, drawn through the moved mesh at its
 *   own landmarks (`uv`) over the warped photo (expression-overlay.ts), at
 *   the expression's weight; its features land where the mesh put them, so
 *   nothing ghosts (a plain cross-fade doubled the smile's folds);
 * - the MOUTH stays the speech's. A picture with a parted-lips smile is
 *   shown at the mouth too while the avatar is silent (`PauseSmile`): its
 *   lips and the band round them, eased in after a quarter second of
 *   silence and out before the next sound.
 *
 * An expression with no picture (none made, or one that failed to load)
 * plays animated, as on an avatar without any.
 */
import { LANDMARK_COUNT } from "./landmarks";
import type { FaceMesh, Point } from "./geometry";
import { pictureMasks, type MaskField, type PictureMasks } from "./expression-picture-masks";

/** The five that may have a picture (the table's names, browFlash aside). */
export const PICTURE_NAMES = ["happy", "surprised", "concerned", "thinking", "serious"] as const;
export type PictureName = (typeof PICTURE_NAMES)[number];

/** Where an avatar's pictures are: the manifest and each picture (presigned). */
export interface ExpressionPictureSource {
  manifestUrl: string;
  imageUrls: Partial<Record<string, string>>;
}

export interface PictureEntry {
  size: [number, number];
  uv: Point[];
  targets: Point[];
  smile: boolean;
}

export interface PictureManifest {
  imageSize: [number, number];
  base: Point[];
  entries: Partial<Record<PictureName, PictureEntry>>;
}

const points = (raw: unknown): Point[] | null => {
  if (!Array.isArray(raw) || raw.length !== LANDMARK_COUNT) return null;
  const out: Point[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    out.push({ x: p[0] as number, y: p[1] as number });
  }
  return out;
};

const size = (raw: unknown): [number, number] | null =>
  Array.isArray(raw) && raw.length === 2 && raw[0] > 0 && raw[1] > 0 ? [Number(raw[0]), Number(raw[1])] : null;

/** The manifest the backend writes (manifest.py), checked; null when it is not one. */
export function parseManifest(json: unknown): PictureManifest | null {
  if (!json || typeof json !== "object") return null;
  const m = json as Record<string, unknown>;
  if (m.version !== 1 || m.kind !== "liveface-expressions") return null;
  const imageSize = size(m.image_size);
  const base = points(m.base);
  if (!imageSize || !base || !m.expressions || typeof m.expressions !== "object") return null;
  const entries: PictureManifest["entries"] = {};
  for (const name of PICTURE_NAMES) {
    const e = (m.expressions as Record<string, Record<string, unknown> | undefined>)[name];
    if (!e) continue;
    const s = size(e.size),
      uv = points(e.uv),
      targets = points(e.targets);
    if (s && uv && targets) entries[name] = { size: s, uv, targets, smile: e.smile === true };
  }
  return { imageSize, base, entries };
}

/** One loaded picture with its masks. */
export interface LoadedPicture {
  name: PictureName;
  entry: PictureEntry;
  image: CanvasImageSource & { width: number; height: number };
  masks: PictureMasks;
}

/** What loadPictures gives: the points the targets were made on, and the pictures. */
export interface LoadedPictures {
  base: Point[];
  pictures: LoadedPicture[];
}

/**
 * The manifest and each picture it names, fetched and decoded; a picture
 * that fails is left out (its expression plays animated). Rejects only
 * when the manifest itself cannot be had.
 */
export async function loadPictures(
  source: ExpressionPictureSource,
  loadImage: (url: string) => Promise<LoadedPicture["image"]>,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<LoadedPictures> {
  const response = await fetcher(source.manifestUrl, { signal, credentials: "omit" });
  if (!response.ok) throw new Error(`expression manifest ${response.status}`);
  const manifest = parseManifest(await response.json());
  if (!manifest) throw new Error("not an expression manifest");
  const loaded = await Promise.all(
    PICTURE_NAMES.map(async (name): Promise<LoadedPicture | null> => {
      const entry = manifest.entries[name];
      const url = source.imageUrls[name];
      if (!entry || !url) return null;
      try {
        const image = await loadImage(url);
        return { name, entry, image, masks: pictureMasks(entry.uv, entry.size, entry.smile) };
      } catch {
        return null;
      }
    })
  );
  return { base: manifest.base, pictures: loaded.filter((p): p is LoadedPicture => p !== null) };
}

/** A picture, fetched for the GPU and the masks (CORS: the storage serves it so). */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`expression picture failed: ${url}`));
    image.src = url;
  });
}

/** Every vertex's texture point in a picture: the landmarks', then each
 *  derived midpoint's from its parents; past those, the first landmark's
 *  (never drawn: the overlay keeps to the face's triangles). */
export function pictureUV(entry: PictureEntry, mesh: FaceMesh, total: number): Point[] {
  const uv = entry.uv.slice(0, LANDMARK_COUNT).map((p) => ({ x: p.x, y: p.y }));
  for (const [a, b] of mesh.derivedParents) uv.push({ x: (uv[a].x + uv[b].x) / 2, y: (uv[a].y + uv[b].y) / 2 });
  while (uv.length < total) uv.push({ ...uv[0] });
  return uv;
}

/** A picture laid on one mesh: per landmark, how far it moves at 1 (canvas
 *  px) and its weight under each mask. */
export interface LaidPicture {
  picture: LoadedPicture;
  /** (dx, dy) per landmark, canvas px: the target less the base, scaled. */
  shift: Float64Array;
  upper: Float32Array;
  mouth: Float32Array | null;
}

function weigh(field: MaskField, uv: readonly Point[]): Float32Array {
  const out = new Float32Array(LANDMARK_COUNT);
  for (let i = 0; i < LANDMARK_COUNT; i++) out[i] = field.at(uv[i]);
  return out;
}

/** `picture` on `mesh`, its manifest's `base` the points its targets were made on. */
export function layPicture(picture: LoadedPicture, base: readonly Point[], mesh: FaceMesh): LaidPicture {
  // The picture's pixels (the rig's) to the mesh's canvas px.
  const scale = mesh.scale;
  const shift = new Float64Array(LANDMARK_COUNT * 2);
  const { targets } = picture.entry;
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    shift[2 * i] = (targets[i].x - base[i].x) * scale;
    shift[2 * i + 1] = (targets[i].y - base[i].y) * scale;
  }
  return {
    picture,
    shift,
    upper: weigh(picture.masks.upper, picture.entry.uv),
    mouth: picture.masks.mouth ? weigh(picture.masks.mouth, picture.entry.uv) : null,
  };
}

/** How much of the silent smile shows: eased in after QUIET_MS of no
 *  articulation, over RISE_MS, and out over FALL_MS as soon as the speech
 *  heads for a sound (its target, which leads the mouth by the articulation's
 *  smoothing). */
export class PauseSmile {
  static readonly QUIET_MS = 250;
  static readonly RISE_MS = 300;
  static readonly FALL_MS = 90;
  /** Articulation below this is a closed, silent mouth. */
  static readonly SILENT = 0.06;
  level = 0;
  private quietSince: number | null = null;
  private last: number | null = null;

  /** Step to `now`, `articulation` the speech's target opening (0..1). */
  step(now: number, articulation: number): number {
    const dt = this.last === null ? 0 : Math.max(0, now - this.last);
    this.last = now;
    if (articulation > PauseSmile.SILENT) {
      this.quietSince = null;
      this.level = Math.max(0, this.level - dt / PauseSmile.FALL_MS);
      return this.level;
    }
    if (this.quietSince === null) this.quietSince = now;
    if (now - this.quietSince >= PauseSmile.QUIET_MS) this.level = Math.min(1, this.level + dt / PauseSmile.RISE_MS);
    return this.level;
  }
}
