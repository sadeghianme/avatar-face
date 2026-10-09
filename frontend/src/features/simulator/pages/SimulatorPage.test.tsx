/**
 * The Simulator against hostile input (the review's N1): a link's
 * `?avatar=` is prefilled only when it is an id, a pasted snippet's values
 * reach the customer's page as values (never as script), that page runs in
 * a frame without allow-same-origin, and only that frame may write to the
 * log.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SimulatorPage } from "@/features/simulator";
import { translate } from "@/i18n";
import { renderScreen } from "@/test/render";
import { createServer } from "@/test/server";

const t = translate;
const ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "lfsim_dGVzdA.0123456789abcdef";
/** The review's proof of concept: a value that closed the attribute and the tag. */
const POC = `x" data-size='"></script><script>parent.postMessage(localStorage.getItem("liveface.tokens"),"*")</script><script x="'`;
/** One payload per kind: quotes, a closing tag and a new script, an event handler. */
const PAYLOADS = [
  POC,
  `"><script>alert(1)</script>`,
  `' onload='alert(1)`,
  `" onerror="alert(1)`,
  "<img src=x onerror=alert(1)>",
];

function simulator(route: string) {
  const server = createServer();
  server.on("POST", "/orgs/:org/api-keys/simulator-token", () => ({ token: TOKEN, expires_at: 0, ttl_seconds: 900 }));
  return renderScreen(<SimulatorPage />, { route, server });
}

const snippetBox = () => screen.getByLabelText<HTMLTextAreaElement>(t("simPasteLabel"));
const runButton = () => screen.getByRole("button", { name: t("simRun") });

/** Paste `text` as the snippet (fireEvent: user.type reads `{` and `[` as keys). */
function paste(text: string) {
  fireEvent.change(snippetBox(), { target: { value: text } });
}

/** A snippet as a site owner might paste it, its attributes single-quoted when they hold a double quote. */
function snippet(attributes: Record<string, string>): string {
  const quoted = Object.entries(attributes).map(([name, value]) =>
    value.includes('"') ? `${name}='${value.replace(/'/g, "&#39;")}'` : `${name}="${value}"`
  );
  return `<script ${quoted.join(" ")}></script>`;
}

function frameOnPage(): HTMLIFrameElement {
  const frame = document.querySelector<HTMLIFrameElement>('iframe[title="simulator"]');
  if (!frame) throw new Error("no frame");
  return frame;
}

/** The customer's page the frame was given, parsed (not run). */
function frameDocument(): Document {
  return new DOMParser().parseFromString(frameOnPage().getAttribute("srcdoc") ?? "", "text/html");
}

describe("a link to the Simulator", () => {
  it("prefills the snippet for an avatar id", () => {
    simulator(`/simulator?avatar=${ID}`);
    expect(snippetBox().value).toContain(`data-avatar="${ID}"`);
    expect(runButton()).toBeEnabled();
  });

  it.each([
    ["the review's proof of concept", POC],
    ["an id with a payload after it", `${ID}"><script>alert(1)</script>`],
    ["an id in capitals", ID.toUpperCase()],
    ["a dashed UUID", "01234567-89ab-cdef-0123-456789abcdef"],
  ])("prefills nothing for %s", (_, avatar) => {
    simulator(`/simulator?avatar=${encodeURIComponent(avatar)}`);
    expect(snippetBox()).toHaveValue("");
    expect(runButton()).toBeDisabled();
  });

  it("ignores every other parameter", () => {
    const evil = encodeURIComponent(POC);
    simulator(`/simulator?avatar=${ID}&key=${evil}&src=${evil}&api=${evil}&voice=${evil}&size=${evil}`);
    expect(snippetBox().value).toContain(`data-avatar="${ID}"`);
    expect(snippetBox().value).not.toContain("postMessage");
  });
});

describe("a pasted snippet", () => {
  it("whose avatar is not an id cannot be run", () => {
    simulator("/simulator");
    paste(snippet({ src: "https://x.example/api/liveface.js", "data-avatar": POC, "data-key": "k" }));
    expect(screen.getByText(t("simInvalid", { fields: "avatar" }))).toBeInTheDocument();
    expect(runButton()).toBeDisabled();
  });

  it("whose src is not a web URL cannot be run", () => {
    simulator("/simulator");
    paste(snippet({ src: "javascript:alert(1)//liveface.js", "data-avatar": ID, "data-key": "k" }));
    expect(screen.getByText(t("simInvalid", { fields: "src" }))).toBeInTheDocument();
    expect(runButton()).toBeDisabled();
  });

  it.each(PAYLOADS)("puts no script in the customer's page, whatever its values: %s", async (payload) => {
    const view = simulator("/simulator");
    const values = {
      src: `https://x.example/api/liveface.js?${payload}`,
      "data-avatar": ID,
      "data-key": payload,
      "data-api": `https://x.example/api?${payload}`,
      "data-size": payload,
      "data-provider": payload,
      "data-voice": payload,
      "data-locale": payload,
    };
    paste(snippet(values));
    // The snippet's own key, so that payload reaches the page too.
    await view.user.click(screen.getByRole("radio", { name: t("simModeOwn") }));
    await view.user.click(runButton());

    const doc = await waitFor(frameDocument);
    // Two scripts, both files: the harness, then the widget. No inline one.
    const scripts = [...doc.querySelectorAll("script")];
    expect(scripts.map((s) => s.getAttribute("src"))).toEqual([
      `${window.location.origin}/simulator-frame.js`,
      values.src,
    ]);
    expect(scripts.every((s) => s.textContent === "")).toBe(true);
    // Nothing else was opened, and no element has an event handler.
    expect([...doc.querySelectorAll("*")].map((el) => el.tagName)).toEqual([
      "HTML",
      "HEAD",
      "META",
      "SCRIPT",
      "BODY",
      "SCRIPT",
    ]);
    for (const el of doc.querySelectorAll("*")) {
      expect([...el.attributes].filter((a) => a.name.toLowerCase().startsWith("on"))).toEqual([]);
    }
    // Every value came through as the value it was, and nothing more.
    const widget = scripts[1];
    expect(Object.fromEntries([...widget.attributes].map((a) => [a.name, a.value]))).toEqual(values);
  });
});

describe("the customer's page", () => {
  it("runs in a frame without allow-same-origin, with a test key", async () => {
    const view = simulator(`/simulator?avatar=${ID}`);
    await view.user.click(runButton());
    const frame = await waitFor(frameOnPage);
    // Scripts, and nothing else: no allow-same-origin, so an opaque origin.
    expect(frame.getAttribute("sandbox")?.split(/\s+/)).toEqual(["allow-scripts"]);
    // The minted key goes into the page, not into the textarea.
    expect(frameDocument().querySelector("script[data-avatar]")?.getAttribute("data-key")).toBe(TOKEN);
    expect(snippetBox().value).not.toContain(TOKEN);
  });

  it("is the only window that may write to the log", async () => {
    const view = simulator(`/simulator?avatar=${ID}`);
    await view.user.click(runButton());
    const frame = await waitFor(frameOnPage);

    const say = (source: Window | null, message: string) =>
      fireEvent(window, new MessageEvent("message", { data: { lf: true, level: "ok", message }, source }));
    say(window, "from this window");
    say(frame.contentWindow, "canvas mounted (320x320)");
    fireEvent(
      window,
      new MessageEvent("message", {
        data: { lf: true, level: "pwned", message: "bad level" },
        source: frame.contentWindow,
      })
    );

    expect(await screen.findByText("canvas mounted (320x320)")).toBeInTheDocument();
    expect(screen.queryByText("from this window")).not.toBeInTheDocument();
    expect(screen.queryByText("bad level")).not.toBeInTheDocument();
  });

  it("words a refused line in the member's language, its code beside it", async () => {
    const view = simulator(`/simulator?avatar=${ID}`);
    await view.user.click(runButton());
    const frame = await waitFor(frameOnPage);
    const refused = (message: string, code: string) =>
      fireEvent(
        window,
        new MessageEvent("message", {
          data: { lf: true, level: "error", message, code },
          source: frame.contentWindow,
        })
      );
    refused(
      "speak failed: SpeechError: This line has not been rendered… (404 cloned_line_missing)",
      "cloned_line_missing"
    );
    refused("speak failed: SpeechError: Too many requests (429 rate_limited)", "rate_limited");

    const known = await screen.findByText(t("speechErr.cloned_line_missing"));
    expect(known).toHaveTextContent("(cloned_line_missing)");
    // A code the dashboard has no words for keeps the widget's own line.
    expect(screen.getByText(/Too many requests \(429 rate_limited\)/)).toHaveTextContent("(rate_limited)");
  });
});
