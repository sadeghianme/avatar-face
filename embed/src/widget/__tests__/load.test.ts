import { afterEach, describe, expect, it, vi } from "vitest";

import { unavailableText } from "../failure";
import { WidgetFailure, asFailure, fetchJson, loadScript } from "../load";

/**
 * The widget's downloads (widget/load.ts) and its failure note
 * (widget/failure.ts), below the whole widget that widget.test.ts boots.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJson", () => {
  const answer = (response: Partial<Response>) => vi.stubGlobal("fetch", async () => response);

  it("reads the JSON of a 2xx answer", async () => {
    answer({ ok: true, status: 200, json: async () => ({ points: [] }) });
    await expect(fetchJson("https://x/rig.json", "rig")).resolves.toEqual({ points: [] });
  });

  it("says which part failed, with the status and the API's code, for an HTTP error", async () => {
    answer({
      ok: false,
      status: 429,
      json: async () => ({ code: "rate_limited", detail: "Embed rate limit exceeded" }),
    });
    const failure = await fetchJson("https://x/a", "avatar").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(WidgetFailure);
    expect(failure).toMatchObject({
      stage: "avatar",
      message: "the avatar request answered 429 (rate_limited: Embed rate limit exceeded)",
    });
  });

  it("says nothing it does not know: an error page is only its status", async () => {
    answer({ ok: false, status: 502, json: async () => Promise.reject(new SyntaxError("Unexpected token '<'")) });
    await expect(fetchJson("https://x/rig.json", "rig")).rejects.toMatchObject({
      message: "the rig request answered 502",
    });
  });
});

describe("asFailure", () => {
  it("keeps a WidgetFailure, and files anything else under the stage given", () => {
    const own = new WidgetFailure("rig", "the rig request answered 403");
    expect(asFailure(own, "engine")).toBe(own);
    expect(asFailure(new TypeError("x is undefined"), "engine")).toMatchObject({
      stage: "engine",
      message: "x is undefined",
    });
    expect(asFailure("plain", "model")).toMatchObject({ stage: "model", message: "plain" });
  });
});

describe("loadScript", () => {
  it("touches nothing when the bundle has already run", async () => {
    const appendChild = vi.fn();
    vi.stubGlobal("document", { querySelector: vi.fn(), createElement: vi.fn(), head: { appendChild } });
    await expect(loadScript("https://x/liveface-3d.js", () => true, "model")).resolves.toBeUndefined();
    expect(appendChild).not.toHaveBeenCalled();
  });

  it("fails when the script loads but defines nothing", async () => {
    const script: { src: string; dataset: Record<string, string>; onload?: () => void } = { src: "", dataset: {} };
    vi.stubGlobal("document", {
      querySelector: () => null,
      createElement: () => script,
      head: { appendChild: () => queueMicrotask(() => script.onload?.()) },
    });
    await expect(loadScript("https://x/liveface-3d.js", () => false, "model")).rejects.toMatchObject({
      stage: "model",
      message: "https://x/liveface-3d.js did not load",
    });
    expect(script.dataset.livefaceLoaded).toBe("ok");
  });
});

describe("the failure note", () => {
  it("speaks the avatar's language, English otherwise", () => {
    expect(unavailableText("fr-CA")).toBe("Avatar indisponible");
    expect(unavailableText("en-GB")).toBe("Avatar unavailable");
    expect(unavailableText("de")).toBe("Avatar unavailable");
  });
});
