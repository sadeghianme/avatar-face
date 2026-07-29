// Dev-only visual test harness for the canvas engine.
// Dev-server only; NOT served in production (kept out of public/ because
// it would otherwise be published). Usage in the browser console:
//   const H = await import('/src/devtools/lf-harness.js?v=' + Date.now());
//   await H.boot();
//   H.pose('aa'); H.zoom('aa');
// Renders the avatar on a large offscreen canvas and blows the mouth region
// up on screen, so defects are visible at real resolution.

const AVATAR_ID = "d4210885de3049c19f44e5809a3672d9";
const ENGINE = "/@fs/Users/mehdisadeghian/Documents/Projects/Avatar/embed/src/engine.ts";

let state = null;

async function token() {
  const saved = JSON.parse(localStorage.getItem("liveface.tokens") || "null");
  if (saved?.access_token) {
    const probe = await fetch("/api/orgs", {
      headers: { Authorization: "Bearer " + saved.access_token },
    });
    if (probe.ok) return saved.access_token;
  }
  throw new Error("Log in to the dashboard first — this harness reuses that session.");
}

export async function boot(avatarId = AVATAR_ID) {
  const mod = await import(ENGINE + "?v=" + Date.now());
  const tok = await token();
  const H = { Authorization: "Bearer " + tok };
  const orgs = await (await fetch("/api/orgs", { headers: H })).json();
  const detail = await (
    await fetch(`/api/orgs/${orgs[0].id}/avatars/${avatarId}`, { headers: H })
  ).json();
  const rig = await (await fetch(detail.rig_url, { cache: "no-store" })).json();
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("texture"));
    i.src = detail.image_url;
  });

  document.getElementById("lf-test")?.remove();
  const cv = document.createElement("canvas");
  cv.id = "lf-test";
  cv.width = 1100;
  cv.height = 1100;
  Object.assign(cv.style, { position: "fixed", left: "-4000px", top: "0" });
  document.body.appendChild(cv);

  document.getElementById("lf-zoom")?.remove();
  const z = document.createElement("canvas");
  z.id = "lf-zoom";
  z.width = 760;
  z.height = 470;
  Object.assign(z.style, {
    position: "fixed", left: "12px", top: "12px", zIndex: 99999,
    border: "2px solid #0f0", background: "#111",
  });
  document.body.appendChild(z);

  state = { mod, rig, img, cv, z, zc: z.getContext("2d"), engine: null };
  make();
  return "booted";
}

export function make() {
  state.engine?.destroy?.();
  const e = new state.mod.AvatarEngine(state.cv, state.rig, state.img, {});
  e.tuning.headMotion = 0;
  e.blink = 0;
  e.nextBlinkAt = 1e15;
  e.nextSaccadeAt = 1e15;
  e.gaze = { x: 0, y: 0 };
  e.gazeTarget = { x: 0, y: 0 };
  state.engine = e;
  return e;
}

/** Hold a single viseme and settle the damping, then draw one frame. */
export function pose(name, amount = 1) {
  const e = state.engine;
  const base = e.rig.visemes[name] || {};
  const w = { jawOpen: 0, mouthClose: 0, mouthPucker: 0, mouthFunnel: 0, mouthStretch: 0, mouthSmile: 0 };
  for (const k of Object.keys(w)) w[k] = (base[k] ?? 0) * amount;
  Object.defineProperty(e, "targetWeights", { get: () => w, set: () => {}, configurable: true });
  e.speaking = true;
  for (let i = 0; i < 90; i++) e.tick(performance.now() + i * 33);
  e.render();
  return w;
}

export function zoom(label = "", spread = 2.0) {
  const e = state.engine;
  const p = e.deformedPoints(performance.now());
  const m = e.rig.mouth_indices.map((i) => p[i]);
  const xs = m.map((q) => q.x);
  const ys = m.map((q) => q.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const w = (Math.max(...xs) - Math.min(...xs)) * spread;
  const h = w * (state.z.height / state.z.width);
  const zc = state.zc;
  zc.clearRect(0, 0, state.z.width, state.z.height);
  zc.drawImage(state.cv, cx - w / 2, cy - h / 2, w, h, 0, 0, state.z.width, state.z.height);
  zc.fillStyle = "#0f0";
  zc.font = "22px monospace";
  zc.fillText(label, 12, 30);
  return label;
}

/** Render several visemes side by side in one image for comparison. */
export function grid(names = ["sil", "PP", "aa", "E", "oh", "ou"]) {
  const cols = 3;
  const cellW = Math.floor(state.z.width / cols);
  const rows = Math.ceil(names.length / cols);
  const cellH = Math.floor(state.z.height / rows);
  const zc = state.zc;
  zc.clearRect(0, 0, state.z.width, state.z.height);
  names.forEach((name, idx) => {
    pose(name);
    const e = state.engine;
    const p = e.deformedPoints(performance.now());
    const m = e.rig.mouth_indices.map((i) => p[i]);
    const xs = m.map((q) => q.x);
    const ys = m.map((q) => q.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const w = (Math.max(...xs) - Math.min(...xs)) * 1.7;
    const h = w * (cellH / cellW);
    const dx = (idx % cols) * cellW;
    const dy = Math.floor(idx / cols) * cellH;
    zc.drawImage(state.cv, cx - w / 2, cy - h / 2, w, h, dx, dy, cellW, cellH);
    zc.strokeStyle = "#0f0";
    zc.strokeRect(dx, dy, cellW, cellH);
    zc.fillStyle = "#0f0";
    zc.font = "18px monospace";
    zc.fillText(name, dx + 8, dy + 22);
  });
  return names.join(",");
}

export function engine() {
  return state.engine;
}

/**
 * Play a real cue track through the engine and lay consecutive frames out as
 * a filmstrip. Static `pose()` cannot show what the coarticulation blend and
 * the damping do — those are purely temporal — so this is the only way to
 * actually look at smoothness rather than infer it from numbers.
 */
export async function strip(text = "Mama put a poppy in my bag.", opts = {}) {
  const { fps = 20, cols = 8, rows = 4, spread = 1.9 } = opts;
  const res = await fetch("/api/embed/v1/cues", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const { cues, duration_ms } = await res.json();

  const e = make();
  delete e.targetWeights; // drop any getter left behind by pose()
  e.targetWeights = { jawOpen: 0, mouthClose: 0, mouthPucker: 0, mouthFunnel: 0, mouthStretch: 0, mouthSmile: 0 };
  e.cues = cues;
  e.speaking = true;

  const n = cols * rows;
  const step = duration_ms / n;
  const cellW = Math.floor(state.z.width / cols);
  const cellH = Math.floor(state.z.height / rows);
  const zc = state.zc;
  zc.clearRect(0, 0, state.z.width, state.z.height);

  // Advance on a fixed wall-clock so the dt damping sees realistic frames.
  const t0 = performance.now();
  e.cueStart = t0;
  e.lastTickAt = t0;
  let clock = t0;
  const frameMs = 1000 / fps;
  const weights = [];

  for (let i = 0; i < n; i++) {
    const until = t0 + i * step;
    while (clock < until) {
      clock = Math.min(until, clock + frameMs);
      e.tick(clock);
    }
    e.render();
    weights.push({ ...e.weights });

    const p = e.deformedPoints(clock);
    const m = e.rig.mouth_indices.map((k) => p[k]);
    const xs = m.map((q) => q.x);
    const ys = m.map((q) => q.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const w = (Math.max(...xs) - Math.min(...xs)) * spread;
    const h = w * (cellH / cellW);
    const dx = (i % cols) * cellW;
    const dy = Math.floor(i / cols) * cellH;
    zc.drawImage(state.cv, cx - w / 2, cy - h / 2, w, h, dx, dy, cellW, cellH);
    zc.strokeStyle = "#0f0";
    zc.strokeRect(dx, dy, cellW, cellH);
    zc.fillStyle = "#0f0";
    zc.font = "13px monospace";
    zc.fillText(`${Math.round(i * step)}ms`, dx + 5, dy + 15);
  }
  e.speaking = false;

  // Frame-to-frame jaw acceleration: the number the smoothness work targets.
  const jaw = weights.map((w) => w.jawOpen);
  const accel = jaw.slice(2).map((v, i) => Math.abs(v - 2 * jaw[i + 1] + jaw[i]));
  return {
    cues: cues.length,
    durationMs: duration_ms,
    jawPeak: +Math.max(...jaw).toFixed(3),
    maxClose: +Math.max(...weights.map((w) => w.mouthClose)).toFixed(3),
    meanAccel: +(accel.reduce((a, b) => a + b, 0) / accel.length).toFixed(5),
  };
}
