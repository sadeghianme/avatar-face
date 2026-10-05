/**
 * Drive the head3d harness in headless Chrome and save what it renders.
 *
 *   node src/head3d/harness/headless.mjs --subjects DIR --out DIR [--profile DIR]
 *        [--gpu] [--only name] [--cell 300]
 *
 * Serves embed/ (the harness page, the bundles) and DIR as /subjects over a
 * local HTTP server, launches Chrome with software WebGL (SwiftShader; pass
 * --gpu for the machine's own), and for every <name>.glb in DIR asks the
 * page for the viseme sheet, the 2D/3D comparison (when <name>.rig.json and
 * <name>.png or .webp are beside it), the phrase strip and the frame-time
 * bench, writing PNGs and a measurements.json to the out directory.
 *
 * Plain Node (24+: fetch and WebSocket are built in), no puppeteer.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EMBED = resolve(fileURLToPath(import.meta.url), "../../../..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".glb": "model/gltf-binary", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".css": "text/css",
};

function args() {
  const out = { subjects: null, out: null, profile: null, gpu: false, only: null, cell: 300, frames: 240 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gpu") out.gpu = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  if (!out.subjects || !out.out) {
    console.error("usage: headless.mjs --subjects DIR --out DIR [--profile DIR] [--gpu] [--only name]");
    process.exit(2);
  }
  out.cell = Number(out.cell);
  out.frames = Number(out.frames);
  out.profile = out.profile ?? join(out.out, ".chrome-profile");
  return out;
}

function serve(subjects) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let file;
    if (url.pathname.startsWith("/subjects/")) file = join(subjects, url.pathname.slice("/subjects/".length));
    else file = join(EMBED, url.pathname);
    if (!existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "access-control-allow-origin": "*" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port })));
}

function launch(profile, gpu) {
  const flags = [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--window-size=1400,1400",
    "--disable-extensions", "--disable-background-timer-throttling", "--mute-audio",
  ];
  if (!gpu) flags.push("--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-gl=angle");
  flags.push("about:blank");
  const child = spawn(CHROME, flags, { stdio: ["ignore", "ignore", "pipe"] });
  return new Promise((ok, fail) => {
    let text = "";
    child.stderr.on("data", (chunk) => {
      text += chunk;
      const m = text.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) ok({ child, ws: m[1] });
    });
    child.on("exit", (code) => fail(new Error(`chrome exited ${code}: ${text.slice(-400)}`)));
    setTimeout(() => fail(new Error("chrome did not start")), 20000);
  });
}

class Cdp {
  constructor(ws) {
    this.socket = new WebSocket(ws);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.socket.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
    this.ready = new Promise((ok, fail) => {
      this.socket.addEventListener("open", ok);
      this.socket.addEventListener("error", (e) => fail(new Error(String(e.message ?? e))));
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.socket.send(JSON.stringify(msg));
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
  }
}

async function main() {
  const opt = args();
  mkdirSync(opt.out, { recursive: true });
  const { server, port } = await serve(resolve(opt.subjects));
  const { child, ws } = await launch(resolve(opt.profile), opt.gpu);
  const cdp = new Cdp(ws);
  await cdp.ready;
  const measurements = {};
  try {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    const base = `http://127.0.0.1:${port}`;
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await cdp.send(
        "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId
      );
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    };
    const navigate = async () => {
      await cdp.send("Page.navigate", { url: `${base}/src/head3d/harness/index.html` }, sessionId);
      for (let i = 0; i < 200; i++) {
        const ready = await evaluate("typeof window.__head3d !== 'undefined'").catch(() => false);
        if (ready) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      const where = await evaluate("location.href + ' ' + document.readyState").catch((e) => String(e));
      const errors = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown" || e.method === "Log.entryAdded")
        .map((e) => JSON.stringify(e.params).slice(0, 400));
      throw new Error(`harness did not load at ${where}\n${errors.join("\n")}`);
    };
    const savePng = (name, dataUrl) => {
      writeFileSync(join(opt.out, name), Buffer.from(dataUrl.split(",")[1], "base64"));
      console.log(`wrote ${name}`);
    };
    const names = readdirSync(opt.subjects).filter((f) => f.endsWith(".glb")).map((f) => f.slice(0, -4))
      .filter((n) => !opt.only || n === opt.only).sort();
    for (const name of names) {
      await navigate();
      const glb = `/subjects/${name}.glb`;
      const rig = existsSync(join(opt.subjects, `${name}.rig.json`)) ? `/subjects/${name}.rig.json` : null;
      const image = [".png", ".webp", ".jpg"].map((e) => `${name}${e}`).find((f) => existsSync(join(opt.subjects, f)));
      const spec = (extra) => JSON.stringify({ glb, cell: opt.cell, label: name, ...extra });
      savePng(`${name}-sheet.png`, await evaluate(`window.__head3d.run(${spec({ mode: "sheet" })})`));
      if (rig && image) {
        savePng(`${name}-compare-2d.png`, await evaluate(`window.__head3d.run(${spec({ mode: "compare", rig, image: `/subjects/${image}` })})`));
        savePng(`${name}-phrase.png`, await evaluate(`window.__head3d.run(${spec({ mode: "phrase", rig, image: `/subjects/${image}`, cell: 200 })})`));
      } else {
        savePng(`${name}-phrase.png`, await evaluate(`window.__head3d.run(${spec({ mode: "phrase", cell: 200 })})`));
      }
      await navigate();
      measurements[name] = await evaluate(`window.__head3d.run(${JSON.stringify({ mode: "bench", glb, frames: opt.frames })})`);
      console.log(name, JSON.stringify(measurements[name]));
    }
    writeFileSync(join(opt.out, "measurements.json"), JSON.stringify(measurements, null, 2));
  } finally {
    cdp.socket.close();
    child.kill("SIGKILL");
    server.close();
    rmSync(opt.profile, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
