/**
 * The face's marks, and the ones in progress: `npm test` (node --test). Node
 * runs this file as TypeScript by stripping its types, so it imports by file
 * name and uses no syntax that needs compiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { memoryStore } from "./fixtures.ts";
import type { DraftMarks } from "./index.ts";
import { draftMarksKey, forgetDraftMarks, loadDraftMarks, saveDraftMarks } from "./index.ts";

// Which marks are guessed, per line of faces: lines.test.ts (it reads lines.ts).

describe("marks in progress", () => {
  const draft: DraftMarks = { marks: { chin: { x: 5, y: 6 } }, ticked: ["head"] };
  it("come back for the anchors they were placed on, and no others", () => {
    const store = memoryStore();
    saveDraftMarks(store, "c1", "a1", draft);
    assert.deepEqual(loadDraftMarks(store, "c1", "a1"), draft);
    assert.equal(loadDraftMarks(store, "c1", "a2"), null);
    assert.equal(loadDraftMarks(store, "c2", "a1"), null);
    saveDraftMarks(store, "c1", "a1", null);
    assert.equal(loadDraftMarks(store, "c1", "a1"), null);
  });
  it("are forgotten for one creation at a time", () => {
    const store = memoryStore([["other", "kept"]]);
    saveDraftMarks(store, "c1", "a1", draft);
    saveDraftMarks(store, "c1", "a2", draft);
    saveDraftMarks(store, "c2", "a1", draft);
    forgetDraftMarks(store, "c1");
    assert.deepEqual([...store.map.keys()].sort(), [draftMarksKey("c2", "a1"), "other"].sort());
  });
  it("never let a broken or foreign entry into the editor", () => {
    const store = memoryStore([
      [draftMarksKey("c", "bad-json"), "{"],
      [draftMarksKey("c", "no-marks"), JSON.stringify({ ticked: [] })],
      [
        draftMarksKey("c", "stray"),
        JSON.stringify({ marks: { chin: { x: 1, y: 1 }, nose: 1 }, ticked: ["head", "nose"] }),
      ],
    ]);
    assert.equal(loadDraftMarks(store, "c", "bad-json"), null);
    assert.equal(loadDraftMarks(store, "c", "no-marks"), null);
    assert.deepEqual(loadDraftMarks(store, "c", "stray"), { marks: { chin: { x: 1, y: 1 } }, ticked: ["head"] });
  });
  it("survive storage that is missing or throws", () => {
    const throwing = {
      length: 1,
      key: () => {
        throw new Error("blocked");
      },
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(loadDraftMarks(throwing, "c", "a"), null);
    assert.doesNotThrow(() => saveDraftMarks(throwing, "c", "a", draft));
    assert.doesNotThrow(() => forgetDraftMarks(throwing, "c"));
    assert.equal(loadDraftMarks(null, "c", "a"), null);
  });
});
