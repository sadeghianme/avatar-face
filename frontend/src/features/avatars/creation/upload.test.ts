/**
 * The upload's checks: `npm test` (node --test). Node runs this file as
 * TypeScript by stripping its types, so it imports by file name and uses no
 * syntax that needs compiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkFile, MAX_UPLOAD_BYTES, nameFromFile } from "./index.ts";

describe("checkFile", () => {
  it("accepts the three photo types within the size limit", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      assert.equal(checkFile({ name: "a", type, size: 1000 }), null);
    }
  });
  it("refuses other types, and anything over 15 MB", () => {
    assert.equal(checkFile({ name: "a.gif", type: "image/gif", size: 10 }), "unsupported_image_type");
    assert.equal(checkFile({ name: "a.heic", type: "", size: 10 }), "unsupported_image_type");
    assert.equal(checkFile({ name: "a.jpg", type: "image/jpeg", size: MAX_UPLOAD_BYTES + 1 }), "image_too_large");
    assert.equal(checkFile({ name: "a.jpg", type: "image/jpeg", size: MAX_UPLOAD_BYTES }), null);
  });
  it("sends a 3D model to its own importer, whatever its type says", () => {
    assert.equal(checkFile({ name: "Head.GLB", type: "", size: 10 }), "model_file");
    assert.equal(checkFile({ name: "x", type: "model/gltf-binary", size: 10 }), "model_file");
  });
});

describe("nameFromFile", () => {
  it("drops the last extension only, and stays within the API's 128", () => {
    assert.equal(nameFromFile("holiday-2024.final.jpg"), "holiday-2024.final");
    assert.equal(nameFromFile("Ava"), "Ava");
    assert.equal(nameFromFile(`${"x".repeat(200)}.png`).length, 128);
  });
});
