import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { dentalCrownCoverage, extractDentalLayers } from "../dental-texture-model";

/**
 * The backend decides whether a generated teeth photo is handed on by
 * running its port of DentalOralSurface's test (backend/app/services/
 * dental_photo.py): a photo the embed would refuse drops the avatar to the
 * classic mouth. This fixture, written by backend/tests/test_dental_photo.py,
 * holds a synthetic mouth and the layers the port extracts from it; the
 * embed's own extraction must produce the same pixels. If this fails, one
 * side changed and the other must follow.
 */
interface Fixture {
  width: number;
  height: number;
  rgba_zlib_base64: string;
  upper_contour: [number, number][];
  lower_contour: [number, number][];
  coverage: { center: number; mouth_width: number };
  expected: {
    upper: { box: number[]; count: number; sha256: string; coverage: number };
    lower: { box: number[]; count: number; sha256: string };
  };
}

const fixture = (): Fixture =>
  JSON.parse(readFileSync(new URL("./fixtures/dental-extraction.json", import.meta.url), "utf8"));

describe("the backend's port of the teeth-photo extraction", () => {
  it("extracts exactly the layers the embed does", () => {
    const f = fixture();
    const data = new Uint8ClampedArray(inflateSync(Buffer.from(f.rgba_zlib_base64, "base64")));
    expect(data.length).toBe(f.width * f.height * 4);
    const contour = (points: [number, number][]) => points.map(([x, y]) => ({ x, y }));
    const [upper, lower] = extractDentalLayers({ width: f.width, height: f.height, data },
      contour(f.upper_contour), contour(f.lower_contour));
    const digest = (layer: typeof upper) => ({
      box: [layer.box.x, layer.box.y, layer.box.width, layer.box.height],
      count: layer.count,
      sha256: createHash("sha256").update(layer.pixels.data).digest("hex"),
    });
    expect(digest(lower)).toEqual(f.expected.lower);
    expect({ ...digest(upper), coverage: dentalCrownCoverage(upper, f.coverage.center, f.coverage.mouth_width) })
      .toEqual(f.expected.upper);
  });
});
