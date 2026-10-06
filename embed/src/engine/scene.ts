/**
 * The scene the avatar is shown in: the owner's framing (zoom, pan) and
 * what is behind a cut-out (nothing, a colour, a picture).
 */

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

/** The scene's background as drawn: its picture loads in the background
 *  and is drawn once it has; the avatar never waits for it. */
export class Backdrop {
  /** The background picture once it has loaded; null until then, and null
   *  for good when it fails. */
  image: HTMLImageElement | null = null;
  private url: string | null = null;

  /** `alive`: false once the engine is gone, so a late load is dropped. */
  constructor(private readonly alive: () => boolean) {}

  /** Start loading `background`'s picture, if it changed. */
  load(background: SceneBackground | null | undefined): void {
    const url = background?.kind === "image" && background.image_url ? background.image_url : null;
    if (url === this.url) return;
    this.url = url;
    this.image = null;
    if (!url) return;
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (this.alive() && this.url === url) this.image = img;
      };
      img.onerror = () => undefined; // transparent it stays
      img.src = url;
    } catch {
      // No Image in this environment (tests): transparent.
    }
  }

  /**
   * What is behind a cut-out, still: a colour, or a picture cover-fitted to
   * the canvas. An opaque picture covers the whole canvas wherever it
   * reaches, so nothing is drawn for it.
   *
   * Drawn LAST, behind the finished picture (destination-over), not first
   * under it: a cut-out's frame is composed by erasing and adding back (its
   * head's feathered layer, the warp replacing the picture under it;
   * render2d.ts, mesh-warp.ts), and over a backdrop drawn first the erase
   * would cut holes in the backdrop wherever the picture is clear.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    background: SceneBackground | null | undefined,
    cutOut: boolean,
    canvas: { width: number; height: number }
  ): void {
    if (!background || background.kind === "transparent" || !cutOut) return;
    const cw = canvas.width,
      ch = canvas.height;
    if (background.kind === "color" && background.color) {
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = background.color;
      ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
      return;
    }
    const img = this.image;
    if (background.kind !== "image" || !img) return;
    const iw = img.naturalWidth || img.width,
      ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const scale = Math.max(cw / iw, ch / ih);
    const w = iw * scale,
      h = ih * scale;
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.drawImage(img, 0, 0, iw, ih, (cw - w) / 2, (ch - h) / 2, w, h);
    ctx.restore();
  }
}
