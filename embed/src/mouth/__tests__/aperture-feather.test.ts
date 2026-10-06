import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apertureFeather,
  CORNER_REACH,
  CORNER_STOPS,
  cornerWeight,
  edgeSoftness,
  FEATHER_CEILING,
  FEATHER_FLOOR,
  featherAlpha,
  featherAlphaAt,
  FeatheredLayer,
  featherSteps,
  MASK_ERODE,
  MASK_SIGMA,
} from "../aperture-feather";

/** A 2D context that records every call and property set, in order. */
function recorder(log: string[], extra: Record<string, unknown> = {}) {
  const round = (v: unknown) =>
    typeof v === "number"
      ? Math.round(v * 100) / 100
      : v instanceof Object && "id" in v
        ? (v as { id: string }).id
        : String(v);
  const target: Record<string, unknown> = { ...extra };
  return new Proxy(target, {
    get: (obj, key: string) =>
      key in obj
        ? obj[key]
        : (...args: unknown[]) => {
            log.push(`${key}(${args.map(round).join(",")})`);
            // A gradient that records its stops.
            if (key === "createRadialGradient" || key === "createLinearGradient")
              return {
                addColorStop: (o: number, c: string) => {
                  log.push(`addColorStop(${round(o)},${c})`);
                },
              };
            return undefined;
          },
    set: (obj, key: string, value) => {
      obj[key] = value;
      log.push(`${key}=${round(value)}`);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** A canvas whose context is a recorder; `filter` present or absent. */
function canvas(id: string, log: string[], filters: boolean) {
  const ctx = recorder(log, filters ? { filter: "none" } : {});
  return { id, width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

const ring = [
  { x: 100, y: 50 },
  { x: 150, y: 70 },
  { x: 200, y: 50 },
  { x: 150, y: 30 },
];
const aperture = { id: "aperture" } as unknown as Path2D;

describe("the aperture's feather", () => {
  it("is the picture's crispest edge width in the mouth's pixels, clamped", () => {
    // bita at 1200 px: a 285 px mouth on a scan whose crispest edges are
    // 3.3 of its own px, 1.33 canvas px each.
    expect(apertureFeather(285, 3.3 * 1.33)).toBeCloseTo(4.39, 2);
    // A hard clip is a cut, never under the floor; nor is a picture whose
    // sharpness is unknown feathered past it.
    expect(apertureFeather(60, 0.4)).toBe(FEATHER_FLOOR);
    expect(apertureFeather(300, 0)).toBe(FEATHER_FLOOR);
    expect(apertureFeather(300, undefined)).toBe(FEATHER_FLOOR);
    expect(apertureFeather(300, NaN)).toBe(FEATHER_FLOOR);
    // ...and a very soft picture never past the ceiling.
    expect(apertureFeather(300, 24)).toBeCloseTo(FEATHER_CEILING * 300, 6);
    expect(FEATHER_CEILING * 300).toBeLessThan(24);
    // A tiny mouth: the floor wins over the ceiling.
    expect(apertureFeather(10, 24)).toBe(FEATHER_FLOOR);
  });

  it("rates a crisp picture 0 and a smooth one 1", () => {
    expect(edgeSoftness(0.006)).toBe(0);
    expect(edgeSoftness(0.01)).toBe(0);
    expect(edgeSoftness(0.03)).toBe(1);
    expect(edgeSoftness(0.02)).toBeCloseTo(0.5, 6);
    expect(edgeSoftness(undefined)).toBe(0);
    expect(edgeSoftness(NaN)).toBe(0);
  });

  it("stays inside the aperture: nothing a feather outside the edge, whole two feathers inside", () => {
    for (const feather of [1.2, 3, 4.5, 9]) {
      expect(featherAlpha(-feather, feather)).toBeLessThan(1 / 255 / 2);
      expect(featherAlpha(0, feather)).toBeLessThan(0.12);
      expect(featherAlpha(feather * 1.5, feather)).toBeGreaterThan(0.99);
      expect(featherAlpha(feather * 2, feather)).toBeGreaterThan(1 - 1 / 255 / 2);
      expect(featherAlpha(feather * MASK_ERODE, feather)).toBeCloseTo(0.5, 6);
      let previous = 0;
      for (let d = -2 * feather; d <= 3 * feather; d += feather / 10) {
        const a = featherAlpha(d, feather);
        expect(a).toBeGreaterThanOrEqual(previous);
        previous = a;
      }
    }
  });

  it("keeps the corners crisp: the hard aperture stamped back, whole at the corner and gone 0.2 W inward, never outside the edge", () => {
    expect(CORNER_REACH).toBeCloseTo(0.2, 6);
    const reach = CORNER_REACH * 300;
    expect(cornerWeight(0, reach)).toBe(1);
    expect(cornerWeight(reach / 2, reach)).toBeCloseTo(0.5, 6);
    expect(cornerWeight(reach, reach)).toBe(0);
    expect(cornerWeight(reach * 2, reach)).toBe(0);
    expect(cornerWeight(5, 0)).toBe(0);
    let previous = 1;
    for (let d = 0; d <= reach; d += reach / 50) {
      const w = cornerWeight(d, reach);
      expect(w).toBeLessThanOrEqual(previous);
      previous = w;
    }
    for (const feather of [1.2, 4.5, 9]) {
      for (const corner of [0, 0.3, 0.7, 1]) {
        // Whole just inside the edge at the corner itself; the feather's own profile where the stamp is gone.
        expect(featherAlphaAt(0.01, feather, 1)).toBeGreaterThan(0.99);
        expect(featherAlphaAt(feather, feather, 0)).toBe(featherAlpha(feather, feather));
        // Never under the feather's alpha, never over 1, monotone inward.
        let last = 0;
        for (let d = -2 * feather; d <= 3 * feather; d += feather / 10) {
          const a = featherAlphaAt(d, feather, corner);
          expect(a).toBeGreaterThanOrEqual(featherAlpha(d, feather) - 1e-12);
          expect(a).toBeLessThanOrEqual(1);
          expect(a).toBeGreaterThanOrEqual(last - 1e-12);
          last = a;
        }
        // Outside the edge the stamp adds nothing: a feather away, under 1/255, corners included.
        expect(featherAlphaAt(-feather, feather, corner)).toBeCloseTo(featherAlpha(-feather, feather), 12);
        expect(featherAlphaAt(-feather, feather, corner)).toBeLessThan(1 / 255 / 2);
        expect(featherAlphaAt(-0.01, feather, corner)).toBeLessThan(0.12);
      }
    }
    // The gradient's stops follow the weight.
    expect(CORNER_STOPS[0]).toEqual([0, 1]);
    expect(CORNER_STOPS[CORNER_STOPS.length - 1]).toEqual([1, 0]);
    for (const [t, a] of CORNER_STOPS) expect(a).toBeCloseTo(cornerWeight(t * reach, reach), 6);
  });

  it("has an edge as wide as the feather, by the measure the picture's own edges are read with", () => {
    // contrast / steepest 1 px step (character-mouth.ts edgeWidth) of the
    // profile, sampled on the pixel grid across the edge. A 1 px step under-
    // reads the slope of a feather only a couple of px wide, so that one
    // measures a little over itself, as the rendered one will.
    for (const feather of [2, 4.3, 8]) {
      const lum: number[] = [];
      for (let d = -3 * feather; d <= 4 * feather; d += 1) lum.push(100 - 80 * featherAlpha(d, feather));
      const contrast = Math.max(...lum) - Math.min(...lum);
      let steepest = 0;
      for (let i = 0; i + 1 < lum.length; i++) steepest = Math.max(steepest, Math.abs(lum[i + 1] - lum[i]));
      const width = contrast / steepest;
      expect(width).toBeGreaterThan(feather * 0.9);
      expect(width).toBeLessThan(Math.max(feather * 1.15, feather + 0.6));
    }
    expect(MASK_SIGMA * Math.sqrt(2 * Math.PI)).toBeCloseTo(1, 1);
  });

  it("without filters: stepped rings that leave the profile's alpha in each band, the innermost clearing the erosion", () => {
    const feather = 4;
    const steps = featherSteps(feather);
    expect(steps).toHaveLength(9);
    for (let i = 1; i < steps.length; i++) expect(steps[i].lineWidth).toBeLessThan(steps[i - 1].lineWidth);
    expect(steps[steps.length - 1].alpha).toBe(1);
    expect(steps[0].lineWidth).toBeGreaterThan(2 * feather);
    // What is left at a distance d inside the edge after every ring that reaches it.
    const left = (d: number) => steps.reduce((kept, s) => (s.lineWidth / 2 > d ? kept * (1 - s.alpha) : kept), 1);
    for (const d of [0.14, 0.3, 0.45, 0.6, 0.75, 0.9, 1.05, 1.3].map((k) => k * feather)) {
      const band = steps.find(
        (s, i) => s.lineWidth / 2 > d && (i === steps.length - 1 || steps[i + 1].lineWidth / 2 <= d)
      );
      expect(band).toBeDefined();
      expect(Math.abs(left(d) - featherAlpha(d, feather))).toBeLessThan(0.05);
    }
    expect(left(0.05 * feather)).toBe(0);
    expect(left(2 * feather)).toBe(1);
  });
});

describe("the feathered layer", () => {
  let log: string[];
  let main: string[];
  let made: HTMLCanvasElement[];
  let filters = true;
  beforeEach(() => {
    log = [];
    main = [];
    made = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const c = canvas(`c${made.length}`, log, filters);
        made.push(c);
        return c;
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    filters = true;
  });

  it("paints the interior with the face's coordinates on a canvas of the aperture's size, and brings it back through the eroded, blurred aperture", () => {
    const layer = new FeatheredLayer();
    const ctx = recorder(main, { getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
    const feather = 4;
    const lc = layer.begin(ctx, ring, feather)!;
    expect(lc).not.toBeNull();
    expect(made).toHaveLength(2);
    // Two canvases, both large enough for the ring plus the feather's margin.
    const margin = Math.ceil(feather * 2 + 2);
    expect(made[0].width).toBe(100 + 2 * margin);
    expect(made[0].height).toBe(40 + 2 * margin);
    expect(made[1].width).toBe(made[0].width);
    // The layer's transform: the face's, shifted so the ring's corner lands a margin in.
    expect(log).toContain(`setTransform(1,0,0,1,${margin - 100},${margin - 30})`);
    expect(log[log.length - 1]).toBe("save()");
    log.length = 0;
    lc.fillRect(1, 2, 3, 4);
    layer.end(ctx, aperture, feather);
    const text = log.join(" ");
    const size = `${made[0].width},${made[0].height}`;
    // Restored to what begin() left, then the mask: fill, erode by a stroke of the feather's width...
    expect(log[1]).toBe("restore()");
    expect(text).toContain("fill(aperture)");
    expect(text).toContain(
      `globalCompositeOperation=destination-out strokeStyle=#000 lineJoin=round lineCap=round lineWidth=${feather} stroke(aperture)`
    );
    // ...blurred in place by 0.4 of the feather (the mask over itself, replacing it)...
    expect(text).toContain(
      `setTransform(1,0,0,1,0,0) globalCompositeOperation=copy filter=blur(${(feather * MASK_SIGMA).toFixed(2)}px) drawImage(c1,0,0,${size},0,0,${size}) filter=none`
    );
    // ...then the layer kept where the mask is, with no filter of its own...
    expect(text).toContain(
      `globalAlpha=1 globalCompositeOperation=destination-in drawImage(c1,0,0,${size},0,0,${size}) globalCompositeOperation=source-over`
    );
    expect(text.indexOf("globalCompositeOperation=copy")).toBeLessThan(
      text.indexOf("globalCompositeOperation=destination-in")
    );
    // ...no corner stamps when no corners are given...
    expect(text).not.toContain("createRadialGradient");
    // ...and onto the face in device pixels, at the ring's corner less the margin.
    expect(main.join(" ")).toContain(
      `save() setTransform(1,0,0,1,0,0) globalAlpha=1 drawImage(c0,0,0,${size},${100 - margin},${30 - margin},${size}) restore()`
    );
  });

  it("stamps the hard aperture back at each corner, through its radial weight, after the blur and before the layer is masked", () => {
    const layer = new FeatheredLayer();
    const ctx = recorder(main, { getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
    layer.begin(ctx, ring, 4)!;
    log.length = 0;
    layer.end(ctx, aperture, 4, { points: [ring[0], ring[2]], reach: 20 });
    const text = log.join(" ");
    const stamps = text.split("createRadialGradient").length - 1;
    expect(stamps).toBe(2);
    // Each stamp clipped to its own box, under the face's transform.
    expect(text).toContain(
      "globalCompositeOperation=source-over save() beginPath() rect(80,30,40,40) clip() createRadialGradient(100,50,0,100,50,20)"
    );
    expect(text).toContain("save() beginPath() rect(180,30,40,40) clip() createRadialGradient(200,50,0,200,50,20)");
    expect(text.slice(text.indexOf("createRadialGradient")).split("restore()").length - 1).toBeGreaterThanOrEqual(2);
    for (const [t, a] of CORNER_STOPS)
      expect(text).toContain(`addColorStop(${Math.round(t * 100) / 100},rgba(0,0,0,${a.toFixed(3)}))`);
    // Under the face's transform (shifted into the layer), filled through the aperture, each stamp after the blur and before the mask is applied.
    const blurAt = text.indexOf("globalCompositeOperation=copy"),
      stampAt = text.indexOf("createRadialGradient"),
      maskAt = text.indexOf("globalCompositeOperation=destination-in");
    expect(blurAt).toBeLessThan(stampAt);
    expect(stampAt).toBeLessThan(maskAt);
    expect(text.slice(stampAt, maskAt).split("fill(aperture)").length - 1).toBe(2);
    expect(text.slice(blurAt, stampAt)).toContain("setTransform(1,0,0,1,-90,-20)");
    // No stamps for a corner reach of nothing.
    log.length = 0;
    layer.begin(ctx, ring, 4);
    layer.end(ctx, aperture, 4, { points: [ring[0]], reach: 0 });
    expect(log.join(" ")).not.toContain("createRadialGradient");
  });

  it("carries a rotated, translated face transform into the layer and sizes it to the transformed ring", () => {
    const layer = new FeatheredLayer();
    // A quarter turn about the origin, then 500 right.
    const ctx = recorder(main, { getTransform: () => ({ a: 0, b: 1, c: -1, d: 0, e: 500, f: 0 }) });
    layer.begin(ctx, ring, 2);
    const margin = Math.ceil(2 * 2 + 2);
    // Device x = 500 - y in [430, 470], device y = x in [100, 200].
    expect(made[0].width).toBe(40 + 2 * margin);
    expect(made[0].height).toBe(100 + 2 * margin);
    expect(log).toContain(`setTransform(0,1,-1,0,${500 - (430 - margin)},${0 - (100 - margin)})`);
    layer.end(ctx, aperture, 2);
    expect(main.join(" ")).toContain(
      `drawImage(c0,0,0,${40 + 2 * margin},${100 + 2 * margin},${430 - margin},${100 - margin},`
    );
  });

  it("grows its canvases for a wider mouth and keeps them for a narrower one", () => {
    const layer = new FeatheredLayer();
    const ctx = recorder(main);
    layer.begin(ctx, ring, 2);
    layer.end(ctx, aperture, 2);
    const [w, h] = [made[0].width, made[0].height];
    layer.begin(
      ctx,
      ring.map((p) => ({ x: p.x * 2, y: p.y * 2 })),
      2
    );
    layer.end(ctx, aperture, 2);
    expect(made[0].width).toBeGreaterThan(w);
    expect(made[0].height).toBeGreaterThan(h);
    const [w2, h2] = [made[0].width, made[0].height];
    layer.begin(ctx, ring, 2);
    layer.end(ctx, aperture, 2);
    expect(made[0].width).toBe(w2);
    expect(made[0].height).toBe(h2);
    expect(made).toHaveLength(2);
    // Only the used part is cleared and drawn.
    expect(main[main.length - 2]).toBe(`drawImage(c0,0,0,${w},${h},${100 - 6},${30 - 6},${w},${h})`);
  });

  it("blurs a band in one pass: drawn on the mask's canvas, brought over through the filter", () => {
    const layer = new FeatheredLayer();
    const ctx = recorder(main);
    layer.begin(ctx, ring, 4);
    log.length = 0;
    layer.blurred((c) => c.stroke(aperture), 2);
    const text = log.join(" ");
    expect(text).toContain("clearRect(0,0,");
    expect(text).toContain("stroke(aperture)");
    expect(text).toContain("filter=blur(2.00px) drawImage(c1,0,0,");
    expect(text.indexOf("stroke(aperture)")).toBeLessThan(text.indexOf("filter=blur(2.00px)"));
  });

  it("without canvas filters: stepped rings for the mask, the band unblurred, no filter ever set", () => {
    filters = false;
    const layer = new FeatheredLayer();
    const ctx = recorder(main);
    const feather = 4;
    expect(layer.begin(ctx, ring, feather)).not.toBeNull();
    layer.blurred((c) => c.stroke(aperture), 2);
    layer.end(ctx, aperture, feather);
    const text = log.join(" ");
    expect(text).not.toContain("filter=");
    const steps = featherSteps(feather);
    for (const s of steps)
      expect(text).toContain(
        `lineWidth=${Math.round(s.lineWidth * 100) / 100} globalAlpha=${Math.round(s.alpha * 100) / 100} stroke(aperture)`
      );
    expect(log.filter((l) => l === "stroke(aperture)")).toHaveLength(steps.length + 1);
    expect(text).toContain("globalAlpha=1 globalCompositeOperation=destination-in drawImage(c1,0,0,");
  });

  it("has no layer without a document, and none after a context is refused", () => {
    vi.stubGlobal("document", undefined);
    expect(new FeatheredLayer().begin(recorder(main), ring, 2)).toBeNull();
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
    const layer = new FeatheredLayer();
    expect(layer.begin(recorder(main), ring, 2)).toBeNull();
    expect(layer.begin(recorder(main), ring, 2)).toBeNull();
    layer.end(recorder(main), aperture, 2);
    expect(main).toEqual([]);
  });
});
