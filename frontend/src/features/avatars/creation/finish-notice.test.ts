/**
 * The finish's notice for the avatar's page: `npm test` (node --test). Node
 * runs this file as TypeScript by stripping its types, so it imports by file
 * name and uses no syntax that needs compiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { memoryStore } from "./fixtures.ts";
import { finishNoticeFor, finishNoticeKey, forgetFinishNotice, rememberFinishNotice } from "./index.ts";

describe("the finish notice", () => {
  const warnings = [{ code: "teeth_showing", detail: "The lips are parted" }];

  it("reaches the avatar's page, for that avatar only, until dismissed", () => {
    const store = memoryStore();
    rememberFinishNotice(store, "av1", warnings);
    assert.deepEqual(finishNoticeFor(store, "av1"), { warnings });
    assert.equal(finishNoticeFor(store, "av2"), null);
    forgetFinishNotice(store, "av1");
    assert.equal(finishNoticeFor(store, "av1"), null);
  });
  it("is kept with no warnings: arriving from the wizard is itself news", () => {
    const store = memoryStore();
    rememberFinishNotice(store, "av1", []);
    assert.deepEqual(finishNoticeFor(store, "av1"), { warnings: [] });
  });
  it("lets nothing malformed through", () => {
    const store = memoryStore([
      [finishNoticeKey("bad"), "{"],
      [finishNoticeKey("none"), JSON.stringify({})],
      [
        finishNoticeKey("mixed"),
        JSON.stringify({ warnings: [null, 3, { code: 1 }, { code: "mouth_open" }, ...warnings] }),
      ],
    ]);
    assert.equal(finishNoticeFor(store, "bad"), null);
    assert.equal(finishNoticeFor(store, "none"), null);
    assert.deepEqual(finishNoticeFor(store, "mixed"), {
      warnings: [{ code: "mouth_open", detail: "" }, ...warnings],
    });
  });
  it("survives storage that is missing or throws", () => {
    const throwing = {
      length: 0,
      key: () => null,
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
    rememberFinishNotice(throwing, "av1", warnings);
    forgetFinishNotice(throwing, "av1");
    assert.equal(finishNoticeFor(throwing, "av1"), null);
    rememberFinishNotice(null, "av1", warnings);
    assert.equal(finishNoticeFor(null, "av1"), null);
  });
});
