import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/**
 * The real pictures the tests read: 8-bit, non-interlaced PNG crops under
 * fixtures/real-crops, decoded here without a browser, as RGB.
 */
export function decodePng(file: string): { w: number; h: number; rgb: Uint8Array } {
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

/** The crop as RGBA, as getImageData would give it. */
export function rgbaOf(png: { w: number; h: number; rgb: Uint8Array }): Uint8ClampedArray {
  const data = new Uint8ClampedArray(png.w * png.h * 4);
  for (let i = 0; i < png.w * png.h; i++) {
    data[i * 4] = png.rgb[i * 3]; data[i * 4 + 1] = png.rgb[i * 3 + 1]; data[i * 4 + 2] = png.rgb[i * 3 + 2]; data[i * 4 + 3] = 255;
  }
  return data;
}
