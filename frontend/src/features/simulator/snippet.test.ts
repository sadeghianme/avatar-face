import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  avatarFromQuery,
  buildDocument,
  escapeAttribute,
  frameMessage,
  invalidFields,
  isAvatarId,
  needsNewToken,
} from "./snippet.ts";

const at = 0;
const FRESH = ["Starting…", "Key renewed"];
const ID = "0123456789abcdef0123456789abcdef";
const HARNESS = "https://dash.example/simulator-frame.js";
/** The review's proof of concept: a value that closed the attribute and the tag. */
const POC = `x" data-size='"></script><script>parent.postMessage(localStorage.getItem("liveface.tokens"),"*")</script><script x="'`;

describe("the Simulator's key", () => {
  it("is renewed when the widget refuses it", () => {
    const log = [
      { at, level: "info", message: "Starting…" },
      { at, level: "error", message: "speak failed: 401 simulator_token_invalid" },
    ] as const;
    assert.equal(needsNewToken(log, FRESH), true);
  });

  it("is not renewed again for a refusal from before the last renewal", () => {
    const log = [
      { at, level: "info", message: "Starting…" },
      { at, level: "error", message: "speak failed: 401" },
      { at, level: "info", message: "Key renewed" },
      { at, level: "ok", message: "finished speaking" },
    ] as const;
    assert.equal(needsNewToken(log, FRESH), false);
  });

  it("ignores other errors", () => {
    const log = [{ at, level: "error", message: "script failed to load" }] as const;
    assert.equal(needsNewToken(log, FRESH), false);
  });
});

describe("an avatar id", () => {
  it("is the API's: 32 lowercase hex digits", () => {
    assert.equal(isAvatarId(ID), true);
    for (const bad of [
      "",
      "av1",
      ID.toUpperCase(),
      `${ID}0`,
      ID.slice(1),
      "01234567-89ab-cdef-0123-456789abcdef",
      `${ID}"`,
      ` ${ID}`,
      `${ID}\n`,
      POC,
      null,
      undefined,
    ]) {
      assert.equal(isAvatarId(bad), false, `accepted ${JSON.stringify(bad)}`);
    }
  });

  it("is the only thing a link prefills, and only when it is one", () => {
    assert.equal(avatarFromQuery(new URLSearchParams({ avatar: ID })), ID);
    assert.equal(avatarFromQuery(new URLSearchParams({ avatar: POC })), null);
    assert.equal(avatarFromQuery(new URLSearchParams({ avatar: `${ID}"><script>` })), null);
    assert.equal(avatarFromQuery(new URLSearchParams({ key: ID, src: "https://evil.example/x.js" })), null);
    assert.equal(avatarFromQuery(new URLSearchParams()), null);
  });
});

describe("a snippet's values", () => {
  it("are refused when they cannot be run", () => {
    const good = { src: "https://x.example/api/liveface.js", avatar: ID, api: "https://x.example/api" };
    assert.deepEqual(invalidFields(good), []);
    assert.deepEqual(invalidFields({ ...good, avatar: POC }), ["avatar"]);
    assert.deepEqual(invalidFields({ ...good, src: "javascript:alert(1)//liveface" }), ["src"]);
    assert.deepEqual(invalidFields({ ...good, src: "data:text/javascript,alert(1)//liveface" }), ["src"]);
    assert.deepEqual(invalidFields({ ...good, api: "/relative" }), ["api"]);
    // Missing is not invalid: the page says which are missing.
    assert.deepEqual(invalidFields({ src: good.src }), []);
  });

  it("are escaped for an attribute", () => {
    assert.equal(escapeAttribute(`a&b"c'd<e>f`), "a&amp;b&quot;c&#39;d&lt;e&gt;f");
    assert.equal(escapeAttribute("&quot;"), "&amp;quot;");
    assert.equal(escapeAttribute("lfsim_abc.123-x"), "lfsim_abc.123-x");
  });
});

describe("the customer's page", () => {
  it("carries the snippet's attributes and loads the Simulator's harness first", () => {
    const html = buildDocument({ src: "https://x.example/api/liveface.js", avatar: ID, key: "k1" }, HARNESS);
    assert.match(html, /<script src="https:\/\/dash\.example\/simulator-frame\.js"><\/script>/);
    assert.match(html, /src="https:\/\/x\.example\/api\/liveface\.js"/);
    assert.match(html, new RegExp(`data-avatar="${ID}"`));
    assert.match(html, /data-key="k1"/);
    assert.doesNotMatch(html, /data-voice/);
    assert.ok(html.indexOf("simulator-frame.js") < html.indexOf("liveface.js"), "the harness loads before the widget");
  });

  it("has no inline script and no event handler, whatever the values", () => {
    const html = buildDocument(
      {
        src: `https://x.example/api/liveface.js?"></script><script>alert(1)</script>`,
        avatar: ID,
        key: POC,
        api: `https://x.example/api?' onload='alert(1)`,
        size: POC,
        provider: "<script>alert(1)</script>",
        voice: `" onerror="alert(1)`,
        locale: `'><img src=x onerror=alert(1)>`,
      },
      HARNESS
    );
    // Exactly two script tags, nothing between their tags, no other element
    // the values could have opened.
    assert.equal(html.match(/<script/g)?.length, 2);
    assert.equal(html.match(/<\/script>/g)?.length, 2);
    assert.doesNotMatch(html, /<script[^>]*>[^<]+<\/script>/);
    assert.doesNotMatch(html, /<img/);
    // Each tag is only double-quoted attributes whose values hold no quote
    // or angle bracket, so none can end early; and the names are ours.
    const [harness = "", widget = ""] = html.match(/<script[^>]*>/g) ?? [];
    const ATTRIBUTE = /\s+([a-z-]+)="[^"'<>]*"/g;
    assert.equal(harness.replace(ATTRIBUTE, ""), "<script>");
    assert.equal(widget.replace(ATTRIBUTE, ""), "<script>");
    assert.deepEqual(
      [...widget.matchAll(ATTRIBUTE)].map((m) => m[1]),
      ["src", "data-avatar", "data-key", "data-api", "data-size", "data-provider", "data-voice", "data-locale"]
    );
  });

  it("is never built from values that cannot be run", () => {
    assert.throws(() => buildDocument({ src: "https://x.example/api/liveface.js", avatar: POC }, HARNESS));
    assert.throws(() => buildDocument({ src: "javascript:alert(1)//liveface", avatar: ID }, HARNESS));
    assert.throws(() => buildDocument({ src: "https://x.example/api/liveface.js" }, HARNESS));
    assert.throws(() => buildDocument({ avatar: ID }, HARNESS));
  });
});

describe("what the customer's page says", () => {
  it("is taken only as a log line", () => {
    assert.deepEqual(frameMessage({ lf: true, level: "ok", message: "canvas mounted" }), {
      level: "ok",
      message: "canvas mounted",
    });
    assert.equal(frameMessage(null), null);
    assert.equal(frameMessage("lf"), null);
    assert.equal(frameMessage({ level: "ok", message: "no lf" }), null);
    assert.equal(frameMessage({ lf: true, level: "warn", message: "unknown level" }), null);
    assert.equal(frameMessage({ lf: true, level: "ok", message: { toString: () => "not a string" } }), null);
    assert.equal(frameMessage({ lf: true, level: "info", message: "x".repeat(5000) })?.message.length, 2000);
  });

  it("keeps a refusal's code only when it looks like one", () => {
    const refused = { lf: true, level: "error", message: "speak failed: SpeechError: …" };
    assert.deepEqual(frameMessage({ ...refused, code: "cloned_line_missing" }), {
      level: "error",
      message: refused.message,
      code: "cloned_line_missing",
    });
    for (const code of [undefined, 404, "", "Not A Code", "x".repeat(80), "<b>"]) {
      assert.deepEqual(frameMessage({ ...refused, code }), { level: "error", message: refused.message });
    }
  });
});
