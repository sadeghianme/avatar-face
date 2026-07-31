// Dev-only: measure blink quality numerically instead of by eye.
//
// A correct blink is monotone — the visible eye shrinks to nothing and comes
// back. The "double eye" failure shows up as TWO separated dark bands inside
// the eye opening (the descending lid, plus a squashed remnant of the eyeball
// below it), so counting dark row-runs catches it without a human looking.
const PHASES = [0, 0.08, 0.15, 0.22, 0.3, 0.4, 0.5, 0.62, 0.75, 0.88, 0.96];
const UPPER = [[246,161,160,159,158,157,173],[466,388,387,386,385,384,398]];
const LOWER = [[7,163,144,145,153,154,155],[249,390,373,374,380,381,382]];
const CORN = [[33,133],[263,362]];

function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("image " + src));
    i.src = src;
  });
}

/** Dark horizontal runs inside the eye box: 1 = one feature, 2+ = doubled. */
function darkRuns(ctx, box) {
  const d = ctx.getImageData(box.x, box.y, box.w, box.h).data;
  const rows = [];
  for (let y = 0; y < box.h; y++) {
    let dark = 0;
    for (let x = 0; x < box.w; x++) {
      const i = (y * box.w + x) * 4;
      if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 105) dark++;
    }
    rows.push(dark / box.w);
  }
  // A row counts as "feature" if a real fraction of it is dark.
  const on = rows.map((r) => r > 0.22);
  let runs = 0;
  for (let y = 1; y < on.length; y++) if (on[y] && !on[y - 1]) runs++;
  if (on[0]) runs++;
  return { runs, darkFraction: rows.reduce((a, b) => a + b, 0) / rows.length };
}

export async function probe(avatars, AvatarEngine, opts = {}) {
  const size = opts.size ?? 1000;
  const results = [];
  for (const av of avatars) {
    const rig = await (await fetch(av.rig, { cache: "no-store" })).json();
    let img;
    try {
      img = await loadImage(av.img);
    } catch {
      continue;
    }
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const e = new AvatarEngine(cv, rig, img, {});
    e.tuning.headMotion = 0;
    e.nextBlinkAt = 1e15;
    e.nextSaccadeAt = 1e15;
    e.nextNodAt = 1e15;
    e.gaze = { x: 0, y: 0 };
    e.gazeTarget = { x: 0, y: 0 };
    const ctx = cv.getContext("2d", { willReadFrequently: true });

    const perPhase = [];
    for (const ph of PHASES) {
      e.blink = ph;
      e.render();
      const pts = e.deformedPoints(performance.now());
      const eyes = [0, 1].map((k) => {
        const ring = [...UPPER[k], ...LOWER[k], ...CORN[k]].map((i) => pts[i]).filter(Boolean);
        const xs = ring.map((p) => p.x);
        const ys = ring.map((p) => p.y);
        const pad = (Math.max(...ys) - Math.min(...ys)) * 0.35;
        const box = {
          x: Math.round(Math.min(...xs)),
          y: Math.round(Math.min(...ys) - pad),
          w: Math.max(2, Math.round(Math.max(...xs) - Math.min(...xs))),
          h: Math.max(2, Math.round(Math.max(...ys) - Math.min(...ys) + pad * 2)),
        };
        return darkRuns(ctx, box);
      });
      perPhase.push({
        phase: ph,
        runs: Math.max(eyes[0].runs, eyes[1].runs),
        dark: +((eyes[0].darkFraction + eyes[1].darkFraction) / 2).toFixed(3),
      });
    }
    e.destroy();

    const open = perPhase[0].dark;
    const closedDark = Math.max(...perPhase.map((p) => p.dark));
    results.push({
      id: av.id.slice(0, 8),
      doubledPhases: perPhase.filter((p) => p.runs > 1).map((p) => p.phase),
      maxRuns: Math.max(...perPhase.map((p) => p.runs)),
      openDark: open,
      peakDark: closedDark,
      perPhase,
    });
  }
  return results;
}
