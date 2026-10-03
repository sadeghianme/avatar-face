import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { needsPersonalOrg, settingUpWorkspace } from "./orgSetup.ts";

describe("the personal organization", () => {
  const base = { userId: "u1", loaded: true, orgCount: 0, requestedFor: null };

  it("is asked for once a new account's list has loaded empty", () => {
    assert.equal(needsPersonalOrg(base), true);
    assert.equal(needsPersonalOrg({ ...base, loaded: false }), false);
    assert.equal(needsPersonalOrg({ ...base, orgCount: 1 }), false);
    assert.equal(needsPersonalOrg({ ...base, userId: null }), false);
  });

  it("is never asked twice for the same user, however often the effect runs", () => {
    assert.equal(needsPersonalOrg({ ...base, requestedFor: "u1" }), false);
    // Another account in the same tab starts afresh.
    assert.equal(needsPersonalOrg({ ...base, userId: "u2", requestedFor: "u1" }), true);
  });

  it("shows a loader, not a blank page, until the workspace exists", () => {
    const s = { userId: "u1", loaded: false, orgCount: 0, failed: false };
    assert.equal(settingUpWorkspace(s), true);
    assert.equal(settingUpWorkspace({ ...s, loaded: true }), true);
    assert.equal(settingUpWorkspace({ ...s, loaded: true, orgCount: 1 }), false);
    assert.equal(settingUpWorkspace({ ...s, loaded: true, failed: true }), false);
    assert.equal(settingUpWorkspace({ ...s, userId: null }), false);
  });
});
