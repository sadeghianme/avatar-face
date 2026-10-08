// Load every page of the running site in headless Chrome and fail on any
// Content-Security-Policy violation (or a page whose document lacks the
// expected security headers). Run against the built images behind a
// Caddy-like proxy (proxy.mjs), so the policy tested is the one nginx sends:
//
//   node deploy/smoke/web-sweep.mjs http://127.0.0.1:7090
//
// It seeds what the pages need through the API itself: a user, a photo
// avatar (published, with a share link) and a 3D avatar, then visits the
// public pages, every dashboard page, the share page (and speaks on it), and
// runs the Simulator's iframe with the real widget for both avatars (and
// speaks there). It also replays the Simulator injection (the review's N1)
// as a link and as a pasted snippet, and fails if the payload ever runs.
//
// Use 127.0.0.1, not localhost: the dashboard points snippets at
// localhost:7002 whenever its origin says "localhost" (the Vite dev setup).
//
// Node 22+ (global WebSocket). CHROME=<path> picks the browser.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
if (!BASE) {
  console.error("usage: node web-sweep.mjs <site-url>");
  process.exit(2);
}
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `check` (which throws until satisfied) for up to `ms`. */
async function eventually(check, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > end) throw error;
      await sleep(500);
    }
  }
}

// ------------------------------------------------------------------ seed ---

async function api(method, path, { token, json, body, headers = {} } = {}) {
  const response = await fetch(path.startsWith("http") ? path : `${BASE}/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function uploadAvatar(token, org, name, file, contentType) {
  const created = await api("POST", `/orgs/${org}/avatars`, { token, json: { name, content_type: contentType } });
  const id = created.avatar.id;
  await api("PUT", created.upload_url, { body: readFileSync(file), headers: { "Content-Type": contentType } });
  await api("POST", `/orgs/${org}/avatars/${id}/uploaded`, { token });
  for (let i = 0; i < 120; i++) {
    const detail = await api("GET", `/orgs/${org}/avatars/${id}`, { token });
    if (detail.status === "ready") {
      if (!detail.published_at) await api("POST", `/orgs/${org}/avatars/${id}/publish`, { token });
      return id;
    }
    if (detail.status === "failed") throw new Error(`${name} failed to build: ${JSON.stringify(detail).slice(0, 300)}`);
    await sleep(500);
  }
  throw new Error(`${name} was not ready after 60s`);
}

async function seed() {
  const user = `sweep${Date.now()}`;
  const password = "sweep-password-1";
  await api("POST", "/auth/register", { json: { email: `${user}@example.com`, username: user, password } });
  const tokens = await api("POST", "/auth/login", { json: { username_or_email: user, password } });
  const token = tokens.access_token;
  let orgs = await api("GET", "/orgs", { token });
  if (!orgs.length) orgs = [await api("POST", "/orgs", { token, json: { name: "Sweep" } })];
  const org = orgs[0].id;
  const photo = await uploadAvatar(token, org, "Photo", join(REPO, "frontend/public/og.jpg"), "image/jpeg");
  const model = await uploadAvatar(
    token,
    org,
    "Model",
    join(REPO, "embed/src/head3d/__tests__/fixtures/synthetic-head.glb"),
    "model/gltf-binary",
  );
  const shared = await api("POST", `/orgs/${org}/avatars/${photo}/share`, { token });
  return { tokens, photo, model, share: shared.share_token };
}

// --------------------------------------------------------------- browser ---

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

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), "liveface-sweep-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,900",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      // WebGL without a GPU, for the 3D engine and the GL warp.
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      ...(process.env.CI ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // What Chrome says on stderr, kept to explain a start that fails (a CI
  // runner image update once made it exit at once, with no message here).
  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  let exited = null;
  chrome.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  let version;
  // Up to 30 s: a cold runner can take well over the 10 s this used to allow.
  for (let i = 0; i < 300 && !version && !exited; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(100);
    }
  }
  if (!version) {
    chrome.kill();
    throw new Error(
      `Chrome did not start${exited ? ` (exited: ${JSON.stringify(exited)})` : " within 30 s"}\n${stderr}`,
    );
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method) {
      for (const listener of listeners) listener(message);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  // Chrome keeps writing its profile until it has exited, so the profile is
  // removed after the exit, with retries; a leftover temp dir must never
  // fail a sweep whose pages all passed.
  const close = async () => {
    ws.close();
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      console.warn(`left the browser profile at ${profile}: ${error.message}`);
    }
  };
  return { send, listeners, close };
}

// Reported from every frame (the Simulator's srcdoc frame among them) and
// every worker, through a binding the page cannot spoof by accident.
const LISTEN = `(() => {
  const report = (e) => {
    const v = { directive: e.effectiveDirective, blocked: e.blockedURI, source: (e.sourceFile || "") + ":" + e.lineNumber,
                sample: e.sample, at: String(self.location && self.location.href).slice(0, 120) };
    try { __cspViolation(JSON.stringify(v)); } catch { console.error("CSP violation " + JSON.stringify(v)); }
  };
  self.addEventListener("securitypolicyviolation", report, true);
})();`;

async function openPage(browser) {
  const { send, listeners } = browser;
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const violations = [];
  const consoleErrors = [];
  const documents = [];
  const responses = [];
  const setup = async (session) => {
    await send("Runtime.addBinding", { name: "__cspViolation" }, session).catch(() => {});
    await send("Runtime.enable", {}, session).catch(() => {});
    await send("Log.enable", {}, session).catch(() => {});
    await send("Runtime.evaluate", { expression: LISTEN }, session).catch(() => {});
  };
  // Out-of-process frames this page opened. The Simulator's is one: its
  // origin is opaque (no allow-same-origin), so Chrome runs it in a process
  // of its own, and its requests, workers and console are reported on its
  // own session, not the page's. Such a frame (an about:srcdoc one) is NOT
  // held at its start the way a worker is: it may already be running when
  // it is attached. So its session is watched at once, every domain asked
  // for in one go, and nothing here depends on seeing its first requests
  // (the Simulator's own log says what its widget did).
  const frames = new Set();
  listeners.add(async (message) => {
    const { method, params } = message;
    if (method === "Target.attachedToTarget" && (message.sessionId === sessionId || frames.has(message.sessionId))) {
      const child = params.sessionId;
      if (params.targetInfo.type === "iframe") {
        frames.add(child);
        await Promise.all(
          [
            send("Network.enable", {}, child),
            send("Log.enable", {}, child),
            send("Runtime.enable", {}, child),
            send("Runtime.addBinding", { name: "__cspViolation" }, child),
            send("Page.enable", {}, child),
            send("Page.addScriptToEvaluateOnNewDocument", { source: LISTEN }, child),
            send("Runtime.evaluate", { expression: LISTEN }, child),
            send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child),
          ].map((call) => call.catch(() => {}))
        );
      } else {
        // Workers: watch them, then let them run.
        await setup(child);
      }
      await send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => {});
    } else if (method === "Runtime.bindingCalled" && params.name === "__cspViolation") {
      violations.push(JSON.parse(params.payload));
    } else if (method === "Log.entryAdded" && params.entry.level === "error") {
      const text = `${params.entry.text} ${params.entry.url ?? ""}`.trim();
      if (/Content.Security.Policy|Refused to/i.test(text)) violations.push({ console: text });
      else consoleErrors.push(text);
    } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
      const text = params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      if (/CSP violation|Refused to/i.test(text)) violations.push({ console: text });
      else consoleErrors.push(text.slice(0, 200));
    } else if (method === "Runtime.exceptionThrown") {
      consoleErrors.push(`exception: ${params.exceptionDetails.exception?.description?.split("\n")[0] ?? params.exceptionDetails.text}`);
    } else if (method === "Network.responseReceived" && (message.sessionId === sessionId || frames.has(message.sessionId))) {
      responses.push({ url: params.response.url, status: params.response.status });
      if (params.type === "Document" && message.sessionId === sessionId)
        documents.push({ url: params.response.url, headers: params.response.headers });
    }
  });
  await send("Page.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: LISTEN }, sessionId);
  await setup(sessionId);
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  return {
    violations,
    consoleErrors,
    documents,
    responses,
    evaluate,
    /** Fail the visit unless a response whose URL contains `part` came back 2xx. */
    answered(part, since = 0) {
      const hit = responses.slice(since).find((r) => r.url.includes(part));
      if (!hit || hit.status >= 300) throw new Error(`${part}: ${hit ? hit.status : "never requested"}`);
    },
    async goto(url, settle = 3000) {
      const loaded = new Promise((resolve) => {
        const listener = (message) => {
          if (message.method === "Page.loadEventFired" && message.sessionId === sessionId) {
            listeners.delete(listener);
            resolve();
          }
        };
        listeners.add(listener);
      });
      await send("Page.navigate", { url }, sessionId);
      await Promise.race([loaded, sleep(20000)]);
      await sleep(settle);
    },
    async type(selector, text) {
      if (!(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)))
        throw new Error(`no ${selector} on ${await evaluate("location.pathname")}`);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await send("Input.insertText", { text }, sessionId);
    },
    async click(text) {
      const clicked = await evaluate(`(() => {
        const el = [...document.querySelectorAll("button:not([disabled])")].find((b) => b.textContent.trim().includes(${JSON.stringify(text)}) || b.getAttribute("aria-label") === ${JSON.stringify(text)});
        if (el) el.click();
        return Boolean(el);
      })()`);
      if (!clicked) throw new Error(`no enabled button "${text}" on ${await evaluate("location.pathname")}`);
    },
  };
}

// ----------------------------------------------------------------- sweep ---

function checkHeaders(documents, path) {
  const doc = documents.findLast((d) => new URL(d.url).origin === new URL(BASE).origin);
  if (!doc) return [`${path}: no document response seen`];
  const headers = Object.fromEntries(Object.entries(doc.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const problems = [];
  const csp = headers["content-security-policy"] ?? "";
  const framed = path.startsWith("/s/");
  if (!csp.includes("default-src 'self'")) problems.push(`${path}: no Content-Security-Policy`);
  if (framed ? !csp.includes("frame-ancestors *") : !csp.includes("frame-ancestors 'none'"))
    problems.push(`${path}: frame-ancestors is wrong for this page: ${csp.split("frame-ancestors")[1] ?? "absent"}`);
  if (framed === Boolean(headers["x-frame-options"])) problems.push(`${path}: X-Frame-Options ${headers["x-frame-options"] ?? "absent"}`);
  for (const name of ["x-content-type-options", "referrer-policy", "permissions-policy"])
    if (!headers[name]) problems.push(`${path}: no ${name}`);
  return problems;
}

const seeded = await seed();
console.log(`seeded: photo ${seeded.photo} (shared as ${seeded.share}), 3D ${seeded.model}`);
// One retry: a first Chrome start on a cold runner can fail where a second succeeds.
const browser = await launch().catch(async (error) => {
  console.warn(`retrying Chrome once: ${error.message}`);
  return launch();
});
const results = [];
let failures = 0;
try {
  const page = await openPage(browser);
  const signIn = () =>
    page.evaluate(`localStorage.setItem("liveface.tokens", ${JSON.stringify(JSON.stringify(seeded.tokens))})`);
  const canvasIn = (selector) =>
    eventually(async () => {
      if (!(await page.evaluate(`Boolean(${selector}?.querySelector("canvas"))`))) throw new Error(`no canvas in ${selector}`);
    });
  // The Simulator's frame has an opaque origin (no allow-same-origin), so
  // this page cannot look inside it: what the frame reports to the
  // Simulator's log is how it says it drew and spoke.
  const logSays = (text, ms) =>
    eventually(async () => {
      if (!(await page.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)))
        throw new Error(`the Simulator's log never said "${text}"`);
    }, ms);
  const isolated = async () => {
    const sandbox = await page.evaluate(`document.querySelector('iframe[title="simulator"]')?.getAttribute("sandbox")`);
    if (sandbox !== "allow-scripts") throw new Error(`the Simulator's frame is sandboxed "${sandbox}", not "allow-scripts"`);
  };
  const simulate = () => async (since) => {
    await eventually(() => page.click("Run snippet"));
    await eventually(isolated);
    // The widget really ran inside the srcdoc frame, under this policy: its
    // liveface:ready (after the avatar, its picture or model and the 3D
    // bundle all loaded), as the frame reports it...
    await logSays("avatar ready", 60000);
    await logSays("canvas mounted");
    await sleep(2000);
    // ...and speaks: the line goes to the frame, its widget to the API.
    await page.type('input[aria-label^="Type something"]', "Hello from the Simulator.");
    await eventually(() => page.click("Speak"));
    await eventually(() => page.answered("/api/embed/v1/synthesize", since), 60000);
    await logSays("finished speaking", 60000);
  };
  // The review's N1: a value that closed data-avatar's quotes and the tag,
  // then ran as an inline script in a frame of the dashboard's origin, with
  // the session's tokens in reach. Run it as a link and as a paste; if it
  // ever runs, the log says PWNED or the title does (the word is built from
  // two halves, so the payload's own text, which the page shows, never
  // matches).
  const steal = `parent.postMessage({lf:true,level:"ok",message:"PW"+"NED "+localStorage.getItem("liveface.tokens")},"*");top.document.title="PW"+"NED"`;
  const poc = `x" data-size='"></script><script>${steal}</script><script x="'`;
  const notPwned = async () => {
    if (await page.evaluate(`document.body.innerText.includes("PWNED") || document.title.includes("PWNED")`))
      throw new Error("the injected script ran");
  };
  const linkRefused = async () => {
    const prefilled = await page.evaluate(`document.querySelector("#snippet")?.value`);
    if (prefilled !== "") throw new Error(`a crafted ?avatar= was prefilled: ${JSON.stringify(prefilled)?.slice(0, 120)}`);
    if (await page.evaluate(`[...document.querySelectorAll("button:not([disabled])")].some((b) => b.textContent.includes("Run snippet"))`))
      throw new Error("Run is enabled for a crafted ?avatar=");
    await notPwned();
  };
  const pasteRefused = (avatar) => async () => {
    // A valid id, and the payload in every other value the frame receives
    // (the paste's own quotes escaped, so each value IS the payload).
    const quoted = (value) => `'${value.replace(/&/g, "&amp;").replace(/'/g, "&#39;")}'`;
    const snippet = `<script src=${quoted(`${BASE}/api/liveface.js?${poc}`)} data-avatar="${avatar}" data-api="${BASE}/api"
      data-size=${quoted(poc)} data-provider=${quoted(poc)} data-voice=${quoted(poc)} data-locale=${quoted(poc)}></script>`;
    await page.type("#snippet", snippet);
    await eventually(() => page.click("Run snippet"));
    await eventually(isolated);
    await logSays("avatar ready", 60000);
    await sleep(3000);
    await notPwned();
  };

  // Signed out first: the auth pages redirect a signed-in visitor away.
  const visits = [
    ["/"],
    ["/login"],
    ["/register"],
    ["/forgot-password"],
    ["/reset-password?token=not-a-real-token"],
    ["/invite/not-a-real-token"],
    [`/s/${seeded.share}`, async (since) => {
      await canvasIn("document");
      await eventually(() => page.type("textarea", "Hello from the security sweep."));
      await eventually(() => page.click("Play"));
      // The audio arrives as a data: URI and plays: media-src.
      await eventually(() => page.answered(`/api/public/v1/avatars/${seeded.share}/speak`, since), 60000);
      await sleep(3000);
    }],
    ["/app", signIn, { reload: true }],
    ["/avatars/new"],
    [`/avatars/${seeded.photo}`, () => canvasIn("document")],
    [`/avatars/${seeded.model}`, () => canvasIn("document")],
    ["/photoface-hd"],
    ["/lip-sync-lab"],
    ["/reference-avatar"],
    ["/voices"],
    ["/members"],
    ["/api-keys"],
    ["/settings"],
    [`/simulator?avatar=${seeded.photo}`, simulate()],
    [`/simulator?avatar=${seeded.model}`, simulate()],
    [`/simulator?avatar=${encodeURIComponent(poc)}`, linkRefused],
    ["/simulator", pasteRefused(seeded.photo)],
  ];
  for (const [path, act, options = {}] of visits) {
    const before = {
      v: page.violations.length,
      e: page.consoleErrors.length,
      d: page.documents.length,
      r: page.responses.length,
    };
    await page.goto(`${BASE}${path}`);
    let note = "";
    try {
      if (act) await act(before.r);
      if (options.reload) await page.goto(`${BASE}${path}`);
    } catch (error) {
      note = `check failed: ${error.message}`;
    }
    const landed = await page.evaluate("location.pathname + location.search");
    const violations = page.violations.slice(before.v);
    const headerProblems = checkHeaders(page.documents.slice(before.d), path);
    const errors = page.consoleErrors.slice(before.e);
    const bad = violations.length + headerProblems.length + (note ? 1 : 0);
    failures += bad;
    results.push({ path, landed, violations: violations.length });
    console.log(`${bad ? "FAIL" : "ok  "} ${path}${landed !== path ? ` (-> ${landed})` : ""}  csp-violations=${violations.length}  console-errors=${errors.length}`);
    for (const v of violations) console.log(`       violation: ${JSON.stringify(v)}`);
    for (const p of headerProblems) console.log(`       header: ${p}`);
    if (note) console.log(`       ${note}`);
    for (const e of errors.slice(0, 5)) console.log(`       console: ${e.slice(0, 220)}`);
  }
} finally {
  await browser.close();
}
console.log(`${results.length} pages, ${results.reduce((n, r) => n + r.violations, 0)} CSP violations, ${failures} failures`);
process.exit(failures ? 1 : 0);
