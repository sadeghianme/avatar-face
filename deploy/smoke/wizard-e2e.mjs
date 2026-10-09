// The whole avatar-creation flow, end to end, as an owner does it, against
// the built images behind the Caddy stand-in (proxy.mjs):
//
//   node deploy/smoke/wizard-e2e.mjs http://127.0.0.1:7090
//
// A fresh account through the register form (never a token injected: the
// dashboard's own sign-in, whatever it stores), then the wizard on its no-AI
// path, the one a server without AI keys offers: 1 Model (Human), 2 Photo (a
// committed portrait, Realistic, the AI box left unticked, the statement
// about the face ticked), 3 Prepare (the photo itself, cut out: "No AI was
// used"), 4 Publish (the points found on the face; one dragged out of
// place, refused, and put back with "Fix it for me"; the talking preview's
// sample played, Publish), then the avatar's page:
// the stage draws, a typed line is spoken in the image's Kokoro voice, the
// public link is turned on and its page plays the line to a signed-out
// visitor; then the avatar is deleted and is gone from both. No console
// error, no page error, no Content-Security-Policy violation, no 5xx, in
// any page or frame, all along.
//
// Every wait is on a state the page shows (a heading, a role, a text, an
// attribute), each bounded; the server's jobs are waited out as the page
// polls them. Nothing sleeps to synchronise. On a failure it saves, in
// $WIZARD_E2E_ARTIFACTS (default: a temp dir, printed), a screenshot of
// every open page, Playwright traces (npx playwright-core show-trace
// <file>), the console and the network log; a screenshot of every step is
// there on success too.
//
// Driven by Playwright (playwright-core, deploy/smoke/package.json; the
// version the widget's browser tests pin) on the Chrome the machine has,
// as web-sweep.mjs uses it: CHROME=<path> picks it. Node 22+.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { chromium } from "playwright-core";

const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
if (!BASE) {
  console.error("usage: node wizard-e2e.mjs <site-url>");
  process.exit(2);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const PORTRAIT = join(HERE, "fixtures", "portrait.jpg");
const OUT = process.env.WIZARD_E2E_ARTIFACTS || join(tmpdir(), `liveface-wizard-e2e-${Date.now()}`);
mkdirSync(join(OUT, "steps"), { recursive: true });

// How long each wait may take, at most: generous for a cold CI runner (the
// first MediaPipe and Kokoro calls load their models), never unbounded.
const SECONDS = 1000;
const LIMIT = {
  page: 60 * SECONDS,
  prepare: 150 * SECONDS,
  publish: 240 * SECONDS,
  speech: 120 * SECONDS,
  whole: 12 * 60 * SECONDS,
};

// ------------------------------------------------------------- watching ---

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const consoleLog = [];
const network = [];
const problems = { console: [], pageErrors: [], csp: [], server: [] };
// The deleted avatar's API addresses, which the last step asks for on
// purpose: their 404 is the answer it checks (Chrome logs it as an error).
const gone = [];
const expectedGone = (text, where) => {
  if (!/status of 404/.test(text) || !where.startsWith(`${BASE}/api/`)) return false;
  const path = new URL(where).pathname;
  return gone.some((part) => path.endsWith(part));
};

// Reported from every frame through a binding the page cannot spoof by
// accident (as web-sweep.mjs does).
const LISTEN = `(() => {
  self.addEventListener("securitypolicyviolation", (e) => {
    const v = { directive: e.effectiveDirective, blocked: e.blockedURI, source: (e.sourceFile || "") + ":" + e.lineNumber,
                sample: e.sample, at: String(self.location && self.location.href).slice(0, 160) };
    try { __cspViolation(JSON.stringify(v)); } catch { console.error("CSP violation " + JSON.stringify(v)); }
  }, true);
})();`;

/** Watch one context (one visitor): its console, errors, CSP and requests. */
async function watch(context, who) {
  await context.exposeBinding("__cspViolation", (_source, payload) => {
    problems.csp.push({ who, ...JSON.parse(payload) });
  });
  await context.addInitScript(LISTEN);
  const onPage = (page) => {
    page.on("console", (message) => {
      const text = message.text();
      const where = message.location()?.url ?? "";
      consoleLog.push(`${elapsed()} [${who}] ${message.type()}: ${text}${where ? `  (${where})` : ""}`);
      if (message.type() !== "error") return;
      if (/Content.Security.Policy|Refused to|CSP violation/i.test(text)) problems.csp.push({ who, console: text });
      else if (!expectedGone(text, where)) problems.console.push(`[${who}] ${text}${where ? ` (${where})` : ""}`);
    });
    page.on("pageerror", (error) => {
      consoleLog.push(`${elapsed()} [${who}] pageerror: ${error.stack ?? error.message}`);
      problems.pageErrors.push(`[${who}] ${error.message}`);
    });
  };
  context.on("page", onPage);
  context.on("requestfinished", async (request) => {
    const response = await request.response().catch(() => null);
    const status = response?.status() ?? 0;
    const entry = {
      at: elapsed(),
      who,
      method: request.method(),
      url: request.url(),
      status,
      type: request.resourceType(),
    };
    network.push(entry);
    if (status >= 500 && request.url().startsWith(BASE))
      problems.server.push(`${entry.method} ${entry.url} -> ${status}`);
  });
  context.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "failed";
    network.push({ at: elapsed(), who, method: request.method(), url: request.url(), status: 0, failure });
  });
}

// ------------------------------------------------------------- helpers ---

let stepNumber = 0;
const steps = [];

/** One step of the flow: timed, logged, and pictured once it passed. */
async function step(name, page, run) {
  const number = String(++stepNumber).padStart(2, "0");
  const from = Date.now();
  process.stdout.write(`${number} ${name} ... `);
  await run();
  const took = ((Date.now() - from) / 1000).toFixed(1);
  steps.push({ number, name, seconds: Number(took) });
  console.log(`ok (${took}s)`);
  await page
    .screenshot({ path: join(OUT, "steps", `${number}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`) })
    .catch(() => {});
}

/** Throw `message` unless `condition`. */
function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** The wizard's progress says step `n` of 4 is the current one. */
async function onStep(page, n) {
  await page
    .getByRole("navigation", { name: "Progress" })
    .locator('li[aria-current="step"]', { hasText: `Step ${n} of 4` })
    .waitFor({ timeout: LIMIT.page });
}

/** The page's one heading, once it says `text`. */
async function heading(page, text, timeout = LIMIT.page) {
  await page.getByRole("heading", { level: 1, name: text, exact: true }).waitFor({ timeout });
}

/**
 * When the button named `name` (its aria-label or its words) inside
 * `scope` is in `state` ("enabled", "disabled", "busy" or "idle", by
 * aria-busy), in the page's own clock (performance.now()). It is looked up
 * afresh on every frame, so a re-render cannot leave this watching a
 * detached node.
 */
async function whenButton(page, scope, name, state, timeout = LIMIT.page) {
  const at = await page.waitForFunction(
    ([scope, name, state]) => {
      const button = [...document.querySelectorAll(`${scope} button`)].find(
        (b) => b.getAttribute("aria-label") === name || b.textContent.trim() === name
      );
      if (!button) return false;
      const busy = button.getAttribute("aria-busy") === "true";
      const now = { enabled: !button.disabled, disabled: button.disabled, busy, idle: !busy }[state];
      return now && performance.now();
    },
    [scope, name, state],
    { timeout }
  );
  return at.jsonValue();
}

/** A PNG (as Chrome's screenshots write it: 8-bit RGB or RGBA, not
 * interlaced) decoded to its pixels. */
function decodePng(buffer) {
  let at = 8;
  let header = null;
  const data = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("ascii", at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === "IHDR")
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        color: body[9],
        interlace: body[12],
      };
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  check(
    header && header.depth === 8 && header.interlace === 0 && [2, 6].includes(header.color),
    "unexpected PNG format"
  );
  const channels = header.color === 6 ? 4 : 3;
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(data));
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const above = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = above ? above[x] : 0;
      const c = above && x >= channels ? above[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = value & 255;
    }
  }
  return { width: header.width, height: header.height, channels, pixels };
}

/**
 * What a canvas shows, as a visitor sees it (a screenshot of the window
 * where it is: the composited result, WebGL or 2D alike; not the element's
 * own screenshot, which waits for an animating element to hold still):
 * sampled on a 48x48 grid, the share of samples that differ from the most
 * common colour, and the spread of their brightness. A blank canvas is one
 * colour.
 */
async function canvasPicture(canvas) {
  const box = await canvas.boundingBox();
  const view = canvas.page().viewportSize();
  check(box, "the canvas is not on the page");
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const clip = {
    x,
    y,
    width: Math.min(box.x + box.width, view.width) - x,
    height: Math.min(box.y + box.height, view.height) - y,
  };
  check(
    clip.width > 64 && clip.height > 64,
    `the canvas shows ${Math.round(clip.width)}x${Math.round(clip.height)} in the window`
  );
  const { width, height, channels, pixels } = decodePng(await canvas.page().screenshot({ type: "png", clip }));
  const samples = [];
  for (let gy = 0; gy < 48; gy++)
    for (let gx = 0; gx < 48; gx++) {
      const x = Math.floor(((gx + 0.5) / 48) * width);
      const y = Math.floor(((gy + 0.5) / 48) * height);
      const i = (y * width + x) * channels;
      samples.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
    }
  const counts = new Map();
  for (const [r, g, b] of samples) {
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [common] = [...counts.entries()].sort((p, q) => q[1] - p[1]);
  const [cr, cg, cb] = common[0].split(",").map((v) => v * 16 + 8);
  const differing = samples.filter(([r, g, b]) => Math.abs(r - cr) + Math.abs(g - cg) + Math.abs(b - cb) > 48).length;
  const light = samples.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b);
  const mean = light.reduce((s, v) => s + v, 0) / light.length;
  const spread = Math.sqrt(light.reduce((s, v) => s + (v - mean) ** 2, 0) / light.length);
  return { differing: differing / samples.length, spread, colours: counts.size };
}

/** Wait until `canvas` shows a picture (not one flat colour). */
async function drawsAPicture(canvas, what) {
  await canvas.waitFor({ state: "visible", timeout: LIMIT.page });
  const until = Date.now() + LIMIT.page;
  let last = null;
  for (;;) {
    last = await canvasPicture(canvas);
    // A face over a backdrop: a fifth of the samples or more off the
    // backdrop's colour, brightness spread wide, dozens of colours.
    if (last.differing > 0.2 && last.spread > 12 && last.colours > 40) return last;
    check(Date.now() < until, `${what} stayed blank: ${JSON.stringify(last)}`);
    // The engine draws on its next frames; the screenshot itself waits for
    // one, so this polls without a fixed sleep.
  }
}

/** Mono PCM16 at 24 kHz, in base64: the characters a second of speech
 * takes in a phrase stream (the frames' cues only add to it). */
const STREAM_BYTES_PER_SECOND = (24000 * 2 * 4) / 3;

// ----------------------------------------------------------------- flow ---

function chromePath() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error("no Chrome found; set CHROME=<path>");
  return found;
}

const user = `wizard${Date.now()}`;
const password = "wizard-e2e-password-1";
const SAID = "Hello from the wizard test.";
const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    // WebGL without a GPU, for the engine's GL warp (as web-sweep.mjs).
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const contextOptions = { viewport: { width: 1440, height: 900 }, locale: "en-US", colorScheme: "light" };
const owner = await browser.newContext(contextOptions);
const visitor = await browser.newContext(contextOptions);
await watch(owner, "owner");
await watch(visitor, "visitor");
for (const context of [owner, visitor]) await context.tracing.start({ screenshots: true, snapshots: true });
owner.setDefaultTimeout(LIMIT.page);
visitor.setDefaultTimeout(LIMIT.page);

/** The console, the network and the steps, as files. */
function saveLogs() {
  writeFileSync(join(OUT, "console.log"), consoleLog.join("\n") + "\n");
  writeFileSync(join(OUT, "network.json"), JSON.stringify(network, null, 1));
  writeFileSync(join(OUT, "steps.json"), JSON.stringify(steps, null, 1));
}

// A step that never returns (a wait without a bound would be a bug here)
// still ends the run: what can be saved is, within half a minute.
const deadline = setTimeout(() => {
  console.error(`\nthe whole flow took over ${LIMIT.whole / 1000}s`);
  setTimeout(() => process.exit(1), 30 * SECONDS).unref();
  void fail(new Error("timed out")).finally(() => process.exit(1));
}, LIMIT.whole);

let failed = false;
async function fail(error) {
  if (failed) return;
  failed = true;
  console.log("FAILED");
  console.error(error.stack ?? String(error));
  saveLogs();
  let n = 0;
  for (const context of [owner, visitor])
    for (const open of context.pages())
      await open.screenshot({ path: join(OUT, `failure-${++n}.png`), timeout: 10 * SECONDS }).catch(() => {});
  await owner.tracing.stop({ path: join(OUT, "trace-owner.zip") }).catch(() => {});
  await visitor.tracing.stop({ path: join(OUT, "trace-visitor.zip") }).catch(() => {});
}

const page = await owner.newPage();
let avatarId = "";
let shareUrl = "";
try {
  await step("register through the form", page, async () => {
    await page.goto(`${BASE}/register`);
    await page.getByLabel("Email", { exact: true }).fill(`${user}@example.com`);
    await page.getByLabel("Username", { exact: true }).fill(user);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    // The dashboard, with the new account's own workspace made.
    await page.waitForURL(`${BASE}/app`);
    await page.getByRole("heading", { name: "No avatars yet" }).waitFor();
  });

  await step("1 Model: Human", page, async () => {
    await page.getByRole("link", { name: "New avatar" }).first().click();
    await heading(page, "What kind of avatar?");
    await onStep(page, 1);
    await page.getByRole("button", { name: /^Human\b/ }).click();
  });

  await step("2 Photo: upload, Realistic, the statement", page, async () => {
    await heading(page, "Give it a face");
    await onStep(page, 2);
    await page.getByRole("radio", { name: /Upload a photo/ }).click();
    // The picker, as a person opens it: the drop zone is a button.
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: /Drop a photo here/ }).click();
    await (await chooser).setFiles(PORTRAIT);
    await page.getByText("portrait.jpg", { exact: true }).waitFor();
    const realistic = page.getByRole("radio", { name: /^Realistic\b/ });
    await realistic.click();
    check((await realistic.getAttribute("aria-checked")) === "true", "Realistic is not chosen");
    // No AI: its box stays unticked (optional for a realistic photo)...
    const ai = page.getByRole("checkbox", { name: /send this photo to AI/ });
    if (await ai.count()) check(!(await ai.isChecked()), "the AI agreement is ticked by default");
    // ...and the statement about the face is required.
    const create = page.getByRole("button", { name: "Create my avatar" });
    check(await create.isDisabled(), "Create my avatar is enabled before the statement is ticked");
    await page.getByRole("checkbox", { name: /I am this person, or I have their permission/ }).check();
    await create.click();
  });

  await step("3 Prepare: the original photo, cut out, no AI", page, async () => {
    await page.waitForURL(/\/avatars\/new\/[0-9a-f-]{32,36}$/);
    await onStep(page, 3);
    // The prepare job (MediaPipe's cut-out and face, in the API image).
    await heading(page, "Here's your avatar", LIMIT.prepare);
    await page.getByText("This is your own photo with its background removed. No AI was used.").waitFor();
    // The picture made, loaded.
    await page.getByRole("img", { name: "After", exact: true }).waitFor();
    await page.waitForFunction(() => {
      const img = document.querySelector('img[alt="After"]');
      return img && img.complete && img.naturalWidth > 0;
    });
    await page.getByRole("button", { name: /Looks good, continue/ }).click();
  });

  await step("4 Publish: the points found, then Publish", page, async () => {
    await heading(page, "Test and publish");
    await onStep(page, 4);
    await page.getByText("Face found automatically").first().waitFor();
    for (const part of ["Eyes", "Lips", "Head"])
      await page.getByRole("list", { name: "Face found automatically" }).getByText(part, { exact: true }).waitFor();
    // The points (each a button named for its part), on the picture, where
    // a face has them: inside the head's outline, the eyes above the mouth,
    // the eye on the left on the left, the mouth between them.
    const picture = await page.locator("button[aria-label^='Eye on the left:']").first().locator("..").boundingBox();
    const points = async (part) => {
      const centres = (
        await Promise.all((await page.locator(`button[aria-label^='${part}:']`).all()).map((p) => p.boundingBox()))
      ).map((b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }));
      check(centres.length > 0, `no "${part}" points on the picture`);
      for (const c of centres)
        check(
          c.x >= picture.x && c.x <= picture.x + picture.width && c.y >= picture.y && c.y <= picture.y + picture.height,
          `a "${part}" point is off the picture`
        );
      const xs = centres.map((c) => c.x);
      const ys = centres.map((c) => c.y);
      const mean = (vs) => vs.reduce((s, v) => s + v, 0) / vs.length;
      return { x: mean(xs), y: mean(ys), top: Math.min(...ys), bottom: Math.max(...ys) };
    };
    const head = await points("Head");
    const left = await points("Eye on the left");
    const right = await points("Eye on the right");
    const mouth = await points("Mouth");
    check(left.x < mouth.x && mouth.x < right.x, "the mouth is not between the eyes");
    check(
      head.top < Math.min(left.y, right.y) && Math.max(left.y, right.y) < mouth.y && mouth.y < head.bottom,
      "the head, the eyes and the mouth are not in a face's order"
    );
    // Never a dead end: points dragged out of place are refused, the page
    // says what to do, and one press puts them back where they were found,
    // which publishes. The eye on the left's outer corner, moved with the
    // keyboard (Shift: ten pixels a press) past the other eye, crosses the
    // eyes.
    const publishButton = page.getByRole("button", { name: "Publish", exact: true });
    await page.getByRole("button", { name: "Eye on the left: left edge", exact: true }).focus();
    for (let n = 0; n < 30; n++) await page.keyboard.press("Shift+ArrowRight");
    const refusal = page.getByRole("alert").filter({ hasText: "These points would stretch the face:" });
    await refusal.waitFor();
    check(await publishButton.isDisabled(), "Publish is enabled on points out of place");
    await page
      .getByText("Move the points listed above back onto the face, or press “Fix it for me”.")
      .first()
      .waitFor();
    await refusal.getByRole("button", { name: "Fix it for me" }).click();
    await refusal.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Publish", exact: true, disabled: false }).waitFor();
    await page.getByText("Face found automatically").first().waitFor();
    // "Press play to hear your avatar talk": the talking preview (the rig
    // Publish would build) says the sample in the server's voice. The
    // button is pressed while it speaks, and comes back when it is done.
    const sample = page.getByRole("button", { name: "Play a sample", exact: true, disabled: false });
    await sample.waitFor();
    const sampleStream = page.waitForResponse(
      (r) => /\/api\/tts\/orgs\/[^/]+\/stream$/.test(r.url()) && r.request().method() === "POST",
      { timeout: LIMIT.speech }
    );
    await sample.click();
    // While it speaks, the same button is named Stop.
    const playing = page.getByRole("button", { name: "Stop", exact: true, pressed: true });
    await playing.waitFor();
    check(
      (await sampleStream).status() === 200,
      "the sample's speech stream failed (it fell back to the browser's voice)"
    );
    await page
      .getByRole("button", { name: "Play a sample", exact: true, pressed: false })
      .waitFor({ timeout: LIMIT.speech });
    await publishButton.click();
    // "Publishing your avatar" while it builds (rig, standard teeth without
    // AI: often too brief to wait on), then the avatar's page, by itself.
    await page.waitForURL(/\/avatars\/[0-9a-f-]{32,36}$/, { timeout: LIMIT.publish });
    avatarId = new URL(page.url()).pathname.split("/").pop();
  });

  await step("the avatar page: the stage draws", page, async () => {
    const stage = page.locator("canvas").first();
    const seen = await drawsAPicture(stage, "the avatar page's stage");
    console.log(
      `\n   stage: ${Math.round(seen.differing * 100)}% off the backdrop, spread ${seen.spread.toFixed(0)}, ${seen.colours} colours`
    );
  });

  await step("Speak: a typed line, in the image's Kokoro voice", page, async () => {
    const panel = page.getByRole("region", { name: "Speak", exact: true });
    await panel.getByRole("textbox", { name: /Type something for your avatar to say/ }).fill(SAID);
    // Enabled once the stage's engine is up and a line is typed.
    const speak = panel.getByRole("button", { name: "Speak", exact: true, disabled: false });
    await speak.waitFor();
    const stream = page.waitForResponse(
      (r) => /\/api\/tts\/orgs\/[^/]+\/stream$/.test(r.url()) && r.request().method() === "POST",
      { timeout: LIMIT.speech }
    );
    // The page's own resource timings, from here on: the stream's entry is
    // read back below (a browser keeps no copy of a streamed body, but it
    // times and counts it).
    await page.evaluate(() => performance.clearResourceTimings());
    await speak.click();
    // Speaking: the button is held until the player has played the last
    // phrase out (its audio clock, not a timer, ends it).
    const SPEAK = 'section[aria-label="Speak"]';
    await whenButton(page, SPEAK, "Speak", "disabled");
    const response = await stream;
    check(response.status() === 200, `the speech stream answered ${response.status()}`);
    // Back, in the page's clock.
    const back = await whenButton(page, SPEAK, "Speak", "enabled", LIMIT.speech);
    const timing = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((e) => /\/api\/tts\/orgs\/[^/]+\/stream$/.test(e.name))
        .map((e) => ({ end: e.responseEnd, bytes: e.decodedBodySize }))
        .pop()
    );
    check(timing, "the page has no timing for its speech stream");
    const audio = timing.bytes / STREAM_BYTES_PER_SECOND;
    const after = (back - timing.end) / 1000;
    // A line this short is one phrase (services/tts/stream.py cuts at 72
    // characters), over a second of speech, and it starts playing no
    // earlier than it arrives: Speak cannot come back much sooner than its
    // length after the stream ended, unless nothing played.
    check(audio > 1, `the speech stream carried ${audio.toFixed(2)}s of audio at most`);
    check(
      after >= audio * 0.8 - 0.1,
      `Speak came back ${after.toFixed(2)}s after the stream, which carried ${audio.toFixed(2)}s`
    );
    check(!(await panel.getByRole("alert").count()), `Speak said: ${await panel.getByRole("alert").allTextContents()}`);
    console.log(
      `\n   streamed up to ${audio.toFixed(2)}s of audio; Speak busy ${after.toFixed(2)}s after the stream ended`
    );
  });

  await step("the public link, turned on", page, async () => {
    await page.getByRole("button", { name: /^Public link/ }).click();
    await page.getByRole("switch", { name: "Public link", checked: false }).click();
    await page.getByRole("switch", { name: "Public link", checked: true }).waitFor();
    const link = page.getByRole("textbox", { name: "Public link" });
    await link.waitFor();
    shareUrl = await link.inputValue();
    check(shareUrl.startsWith(`${BASE}/s/`), `the public link is ${shareUrl}`);
  });

  const shared = await visitor.newPage();
  await step("the share page, signed out: it draws and plays", shared, async () => {
    // A context of its own: none of the owner's cookies or storage.
    await shared.goto(shareUrl);
    await drawsAPicture(shared.locator("canvas"), "the share page's avatar");
    await shared.getByRole("textbox").fill(SAID);
    const play = shared.getByRole("button", { name: "Play", exact: true });
    const spoken = shared.waitForResponse(
      (r) => /\/api\/public\/v1\/avatars\/[^/]+\/speak$/.test(r.url()) && r.request().method() === "POST",
      { timeout: LIMIT.speech }
    );
    await shared.evaluate(() => performance.clearResourceTimings());
    await play.click();
    // Speaking: Play is busy until the engine's audio has ended (its onEnd).
    await whenButton(shared, "footer", "Play", "busy");
    const response = await spoken;
    check(response.status() === 200, `the public speech answered ${response.status()}`);
    const { duration_ms: duration, cues } = await response.json();
    check(
      duration > 1000 && cues?.length > 0,
      `the public speech carried ${duration}ms of audio, ${cues?.length} cues`
    );
    const back = await whenButton(shared, "footer", "Play", "idle", LIMIT.speech);
    const arrived = await shared.evaluate(
      () =>
        performance
          .getEntriesByType("resource")
          .filter((e) => /\/speak$/.test(e.name))
          .pop()?.responseEnd
    );
    check(arrived, "the page has no timing for its speech");
    // So at least as long as the recording after it arrived, unless
    // nothing played.
    const after = (back - arrived) / 1000;
    check(
      after >= (duration / 1000) * 0.9 - 0.1,
      `Play came back ${after.toFixed(2)}s after ${duration}ms of audio arrived`
    );
    check(
      !(await shared.getByRole("alert").count()),
      `the share page said: ${await shared.getByRole("alert").allTextContents()}`
    );
    console.log(
      `\n   played ${(duration / 1000).toFixed(2)}s of audio; Play busy ${after.toFixed(2)}s after it arrived`
    );
  });

  await step("delete the avatar (asked in place)", page, async () => {
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page
      .getByRole("group", { name: "Delete this avatar?" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.waitForURL(`${BASE}/app`);
    await page.getByRole("heading", { name: "No avatars yet" }).waitFor();
  });

  await step("gone: its page and its public link", page, async () => {
    const token = new URL(shareUrl).pathname.split("/").pop();
    gone.push(`/avatars/${avatarId}`, `/api/public/v1/avatars/${token}`);
    await page.goto(`${BASE}/avatars/${avatarId}`);
    await page.getByText("avatar not found in this organization").waitFor();
    await shared.goto(shareUrl);
    await shared.getByRole("heading", { name: "This link is not available" }).waitFor();
  });

  const report = [
    problems.console.length && `console errors:\n  ${problems.console.join("\n  ")}`,
    problems.pageErrors.length && `page errors:\n  ${problems.pageErrors.join("\n  ")}`,
    problems.csp.length && `CSP violations:\n  ${problems.csp.map((v) => JSON.stringify(v)).join("\n  ")}`,
    problems.server.length && `server errors:\n  ${problems.server.join("\n  ")}`,
  ].filter(Boolean);
  check(!report.length, report.join("\n"));
} catch (error) {
  await fail(error);
} finally {
  clearTimeout(deadline);
  saveLogs();
  await browser.close().catch(() => {});
}
console.log(`${failed ? "FAIL" : "ok"}: ${steps.length} steps in ${elapsed()}; screenshots and logs in ${OUT}`);
process.exit(failed ? 1 : 0);
