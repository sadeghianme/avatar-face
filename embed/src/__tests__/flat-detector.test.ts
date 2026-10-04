import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { sampleLook, type Pt, type Rgb } from "../character-mouth";

/**
 * Is the picture cel art? Checked on crops (120 x 96, at the picture's own
 * pixels, round the mouth) of the five REAL AI-made characters the wizard
 * produced, because the first version of the test passed on synthetic
 * pictures and failed on real flat art: AI-made cartoons carry light noise
 * and soft gradients, and a test that wanted near-identical neighbours called
 * them renders, which lost the drawn outline, the flat teeth and the pink
 * tongue.
 */

function decodePng(file: string): { w: number; h: number; rgb: Uint8Array } {
  const buf = readFileSync(new URL(`./fixtures/real-crops/${file}`, import.meta.url));
  let off = 8;
  let w = 0, h = 0, channels = 3;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("8-bit, non-interlaced PNGs only");
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8Array(w * h * 3);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let add = 0;
      if (f === 1) add = a;
      else if (f === 2) add = b;
      else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = line[x * channels + k];
    prev = line;
  }
  return { w, h, rgb: out };
}

function lookOf(file: string) {
  const { w, h, rgb } = decodePng(file);
  const pixel = (x: number, y: number): Rgb | null => {
    const px = Math.round(x), py = Math.round(y);
    if (px < 0 || py < 0 || px >= w || py >= h) return null;
    const i = (py * w + px) * 3;
    return [rgb[i], rgb[i + 1], rgb[i + 2]];
  };
  // The sampler looks at 3 mouth-widths by 2.4: the crop is that area.
  const width = w / 3;
  const cx = w / 2, cy = h * 0.375;
  const seam: Pt[] = [{ x: cx - width * 0.3, y: cy }, { x: cx, y: cy }, { x: cx + width * 0.3, y: cy }];
  return sampleLook(pixel, seam, { cx, cy, w: width }, [150, 90, 80], [200, 160, 140]);
}

describe("telling cel art from a render or a photograph, on real pictures", () => {
  it.each(["human-cartoon", "animal-cartoon"])("calls the %s drawing flat", (name) => {
    expect(lookOf(`${name}-mouth.png`).flat).toBe(true);
  });

  it.each(["human-animation", "animal-animation", "animal-realistic"])("does not call the %s picture flat", (name) => {
    expect(lookOf(`${name}-mouth.png`).flat).toBe(false);
  });
});
