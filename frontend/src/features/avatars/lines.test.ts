/**
 * The three lines of faces, and the marks each guesses: `npm test` (node
 * --test). Node runs this file as TypeScript by stripping its types, so it
 * imports by file name and uses no syntax that needs compiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { confirmedParts, marksAreGuessed, pickMarks } from "./creation/index.ts";
import { LINE_ORDER, LINES } from "./lines.ts";

describe("lines", () => {
  it("offers all three lines, labelling cartoon as its own key", () => {
    assert.deepEqual([...LINE_ORDER], ["human", "animal", "cartoon"]);
    assert.equal(LINES.cartoon.label, "faceType_cartoon");
  });
  it("matches the server's rules: people only for background removal, never one-click animals", () => {
    assert.deepEqual(
      LINE_ORDER.filter((id) => LINES[id].backgroundRemoval),
      ["human"]
    );
    assert.equal(LINES.animal.oneClick, false);
    // services.creations.LINES["animal"].marks
    assert.deepEqual([...LINES.animal.marks], ["head", "left_eye", "right_eye", "mouth_line", "chin"]);
    assert.ok(!LINES.animal.marks.includes("left_pupil"));
    assert.ok(LINES.human.marks.includes("mouth") && !LINES.human.marks.includes("mouth_line"));
  });
});

describe("guessed marks", () => {
  it("are marks on the face template: an animal's always, any face the detector missed", () => {
    assert.equal(marksAreGuessed({ detected: false }, LINES.animal.oneClick), true);
    assert.equal(marksAreGuessed({ detected: true }, LINES.animal.oneClick), true);
    assert.equal(marksAreGuessed({ detected: false }, LINES.human.oneClick), true);
    assert.equal(marksAreGuessed({ detected: false }, LINES.cartoon.oneClick), true);
    assert.equal(marksAreGuessed({ detected: true }, LINES.human.oneClick), false);
  });
  it("count as placed when moved or ticked, and only those are sent", () => {
    const parts = LINES.animal.marks;
    const confirmed = confirmedParts(parts, ["head"], ["chin"]);
    assert.deepEqual(confirmed, ["head", "chin"]);
    const marks = { head: { left: { x: 1, y: 2 } }, chin: { x: 5, y: 6 }, left_eye: { left: { x: 3, y: 4 } } };
    // Nothing unconfirmed reaches finish, so the server sees it as missing.
    assert.deepEqual(pickMarks(marks, confirmed), { head: marks.head, chin: marks.chin });
    assert.deepEqual(pickMarks(marks, ["mouth_line"]), {});
  });
});
