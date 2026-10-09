/**
 * The face's handles and the head's outline, without a browser: `npm test`
 * (node --test). Node runs this file as TypeScript by stripping its types,
 * so it imports the module by its file name.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FaceMarks, Pt, RegionMarks } from "./face-marks.ts";
import {
  catmullRom,
  closedCurvePath,
  FIT_REASON_LABELS,
  handleAt,
  handlesFor,
  HEAD_OUTLINE,
  headOutline,
  marksToSend,
} from "./face-marks.ts";

/** A head with its outline's diagonals: the temples and the jaw corners. */
type FullHead = RegionMarks & Required<Pick<RegionMarks, "upper_left" | "upper_right" | "lower_right" | "lower_left">>;

const pt = (x: number, y: number): Pt => ({ x, y });

// The backend's test head (tests/test_anchor_fit.py): centre 500,500, half
// axes 300 by 350, with its temples and jaw corners at 45 degrees.
const R = Math.SQRT1_2;
const HEAD4: RegionMarks = { left: pt(200, 500), right: pt(800, 500), top: pt(500, 150), bottom: pt(500, 850) };
const HEAD8: FullHead = {
  ...HEAD4,
  upper_left: pt(500 - 300 * R, 500 - 350 * R),
  upper_right: pt(500 + 300 * R, 500 - 350 * R),
  lower_right: pt(500 + 300 * R, 500 + 350 * R),
  lower_left: pt(500 - 300 * R, 500 + 350 * R),
};
const EYE = (cx: number): RegionMarks => ({
  left: pt(cx - 60, 400),
  right: pt(cx + 60, 400),
  top: pt(cx, 360),
  bottom: pt(cx, 440),
});
const marksWith = (head: RegionMarks): FaceMarks => ({
  head,
  left_eye: EYE(390),
  right_eye: EYE(610),
  mouth_line: [pt(330, 700), pt(415, 712), pt(500, 715), pt(585, 712), pt(670, 700)],
  chin: pt(500, 850),
});

/** The cubic Bezier segments of a path from closedCurvePath. */
function segments(d: string): Pt[][] {
  const numbers = (s: string) => s.split(/[ ,]+/).filter(Boolean).map(Number);
  const [move, ...curves] = d.replace(/Z$/, "").split("C");
  let from = numbers(move.slice(1));
  return curves.map((c) => {
    const [x1, y1, x2, y2, x, y] = numbers(c);
    const segment = [pt(from[0], from[1]), pt(x1, y1), pt(x2, y2), pt(x, y)];
    from = [x, y];
    return segment;
  });
}

function bezier([p0, p1, p2, p3]: Pt[], t: number): Pt {
  const u = 1 - t;
  const at = (a: number, b: number, c: number, d: number) =>
    u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  return pt(at(p0.x, p1.x, p2.x, p3.x), at(p0.y, p1.y, p2.y, p3.y));
}

const near = (a: Pt, b: Pt, tolerance = 0.02) =>
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= tolerance, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

describe("the head's outline", () => {
  it("is the Catmull-Rom curve the fit uses (the numbers test_anchor_fit checks)", () => {
    const p = [pt(0, 0), pt(1, 0), pt(2, 1), pt(3, 1)];
    near(catmullRom(p[0], p[1], p[2], p[3], 0), pt(1, 0), 1e-9);
    near(catmullRom(p[0], p[1], p[2], p[3], 1), pt(2, 1), 1e-9);
    near(catmullRom(p[0], p[1], p[2], p[3], 0.5), pt(1.5, 0.5), 1e-9);
  });

  it("is drawn as Bezier segments that are that very curve, through every mark", () => {
    const ring = headOutline(HEAD8);
    const parts = segments(closedCurvePath(ring));
    assert.equal(parts.length, 8);
    parts.forEach((segment, i) => {
      const n = ring.length;
      const [p0, p1, p2, p3] = [ring[(i - 1 + n) % n], ring[i], ring[(i + 1) % n], ring[(i + 2) % n]];
      near(segment[0], p1);
      near(segment[3], p2);
      for (const t of [0.25, 0.5, 0.75]) near(bezier(segment, t), catmullRom(p0, p1, p2, p3, t));
    });
  });

  it("reads as an oval: on the head's ellipse, the curve stays close to it", () => {
    const ring = headOutline(HEAD8);
    for (const segment of segments(closedCurvePath(ring))) {
      for (const t of [0.25, 0.5, 0.75]) {
        const p = bezier(segment, t);
        const r = Math.hypot((p.x - 500) / 300, (p.y - 500) / 350);
        assert.ok(Math.abs(r - 1) < 0.03, `radius ${r}`);
      }
    }
  });

  it("goes round the face clockwise from the top, as the server checks it", () => {
    assert.deepEqual(HEAD_OUTLINE, [
      "top",
      "upper_right",
      "right",
      "lower_right",
      "bottom",
      "lower_left",
      "left",
      "upper_left",
    ]);
    assert.deepEqual(
      headOutline(HEAD8),
      HEAD_OUTLINE.map((edge) => HEAD8[edge])
    );
  });

  it("runs through a chin marked below the head's bottom edge, as the fit does", () => {
    const chin = pt(500, 800); // a dog's jaw, above the ruff the bottom edge bounds
    const ring = headOutline(HEAD8, chin);
    assert.deepEqual(ring[HEAD_OUTLINE.indexOf("bottom")], chin);
    assert.deepEqual(
      ring.filter((_, i) => HEAD_OUTLINE[i] !== "bottom"),
      HEAD_OUTLINE.filter((edge) => edge !== "bottom").map((edge) => HEAD8[edge])
    );
    // Within a hundredth of the head's height it is the bottom edge itself.
    const onEdge = pt(HEAD8.bottom.x + 3, HEAD8.bottom.y);
    assert.deepEqual(headOutline(HEAD8, onEdge), headOutline(HEAD8));
    assert.deepEqual(headOutline(HEAD4, chin)[2], chin);
  });

  it("draws a head saved with four points through those four", () => {
    assert.deepEqual(headOutline(HEAD4), [HEAD4.top, HEAD4.right, HEAD4.bottom, HEAD4.left]);
    assert.equal(segments(closedCurvePath(headOutline(HEAD4))).length, 4);
    assert.equal(closedCurvePath([pt(0, 0), pt(1, 1)]), "");
  });

  it("names the fit's outline refusals", () => {
    assert.equal(FIT_REASON_LABELS.outline_crossed, "fitOutlineCrossed");
    assert.equal(FIT_REASON_LABELS.outline_out_of_order, "fitOutlineOrder");
  });

  it("names a mouth placed above the eyes", () => {
    assert.equal(FIT_REASON_LABELS.mouth_above_eyes, "fitMouthAboveEyes");
  });
});

describe("the handles", () => {
  it("give the head eight, in order round the face, and a four-point head four", () => {
    const ids = (marks: FaceMarks) =>
      handlesFor(marks)
        .filter((h) => h.group === "head")
        .map((h) => h.id);
    assert.deepEqual(
      ids(marksWith(HEAD8)),
      HEAD_OUTLINE.map((edge) => `head.${edge}`)
    );
    assert.deepEqual(ids(marksWith(HEAD4)), ["head.top", "head.right", "head.bottom", "head.left"]);
    const temple = handlesFor(marksWith(HEAD8)).find((h) => h.id === "head.upper_left");
    assert.equal(temple!.label, "markEdgeUpperLeft");
    assert.equal(handlesFor(marksWith(HEAD8)).find((h) => h.id === "head.lower_right")!.label, "markEdgeLowerRight");
  });

  it("move one point of the outline and nothing else", () => {
    const marks = marksWith(HEAD8);
    const jaw = handlesFor(marks).find((h) => h.id === "head.lower_left");
    const moved = jaw!.move(marks, pt(270, 760));
    assert.deepEqual(moved.head.lower_left, pt(270, 760));
    assert.deepEqual({ ...moved.head, lower_left: HEAD8.lower_left }, HEAD8);
    assert.equal(moved.left_eye, marks.left_eye);
  });

  it("are picked nearest first, the new ones among them", () => {
    const marks = marksWith(HEAD8);
    const handles = handlesFor(marks);
    const scale = pt(0.5, 0.5); // a 500px-wide view of a 1000px photo
    // Between the top and the upper-right temple, nearer the temple.
    const between = pt(0.3 * HEAD8.top.x + 0.7 * HEAD8.upper_right.x, 0.3 * HEAD8.top.y + 0.7 * HEAD8.upper_right.y);
    assert.equal(handleAt(handles, marks, between, scale, 40)!.id, "head.upper_right");
    // Right on the jaw corner, with the eyes and the mouth far away.
    assert.equal(handleAt(handles, marks, HEAD8.lower_left, scale, 20)!.id, "head.lower_left");
    // Out of reach of everything.
    assert.equal(handleAt(handles, marks, pt(500, 500), scale, 20), null);
    // The chin sits on the head's bottom: a second press picks the other.
    const first = handleAt(handles, marks, pt(500, 850), scale, 20);
    const second = handleAt(handles, marks, pt(500, 850), scale, 20, first!.id);
    assert.deepEqual(new Set([first!.id, second!.id]), new Set(["head.bottom", "chin"]));
  });
});

describe("what the marking panel sends", () => {
  it("leaves out the diagonals of a head nobody touched", () => {
    const opened = marksWith(HEAD8);
    const sent = marksToSend({ ...opened }, opened);
    assert.deepEqual(sent.head, HEAD4);
    assert.equal(sent.left_eye, opened.left_eye);
  });

  it("sends all eight once any head point moved", () => {
    const opened = marksWith(HEAD8);
    const edge = { ...opened, head: { ...HEAD8, left: pt(190, 500) } };
    assert.deepEqual(marksToSend(edge, opened).head, edge.head);
    const temple = { ...opened, head: { ...HEAD8, upper_left: pt(280, 240) } };
    assert.deepEqual(marksToSend(temple, opened).head, temple.head);
  });

  it("sends a four-point head as it is", () => {
    const opened = marksWith(HEAD4);
    assert.deepEqual(marksToSend(opened, opened).head, HEAD4);
  });
});
