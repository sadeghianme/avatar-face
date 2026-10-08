import type { AvatarEngine } from "@liveface/embed";

/**
 * The demo's intro, outside React: the scan that traces the rig over the
 * face, and the head and body motion eased in after it (DemoAvatar runs
 * them on its engine and its overlay canvas).
 */

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Ease head and body motion in after the scan, instead of switching on. */
export function rampMotion(engine: AvatarEngine, ms: number): void {
  const begin = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - begin) / ms);
    const eased = k * k * (3 - 2 * k);
    engine.tuning.headMotion = eased;
    engine.tuning.bodyMotion = eased;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * The rig, made visible: a scan line sweeps the face and the 478 detected
 * landmarks light up behind it, joined by the triangle mesh the engine warps.
 * Then it all fades and the face starts to move. This is literally what the
 * pipeline does to an uploaded photo, drawn on the landmarks of this one.
 */
export function runScan(
  overlay: HTMLCanvasElement,
  points: ReadonlyArray<Readonly<{ x: number; y: number }>>,
  triangles: number[][],
  onDone: () => void
): () => void {
  const ctx = overlay.getContext("2d");
  if (!ctx || !points.length) {
    onDone();
    return () => undefined;
  }
  const W = overlay.width;
  const H = overlay.height;
  const ys = points.map((p) => p.y);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const span = Math.max(1, bottom - top);
  const SWEEP = 1600;
  const HOLD = 300;
  const FADE = 700;
  const dot = Math.max(1.4, W / 460);
  const begin = performance.now();
  let raf = 0;

  const frame = (now: number) => {
    const t = now - begin;
    ctx.clearRect(0, 0, W, H);
    const k = Math.min(1, t / SWEEP);
    const eased = 1 - (1 - k) ** 3;
    const lineY = top - span * 0.12 + span * 1.24 * eased;
    const fade = t > SWEEP + HOLD ? Math.max(0, 1 - (t - SWEEP - HOLD) / FADE) : 1;

    ctx.globalAlpha = fade;
    ctx.lineWidth = Math.max(0.8, W / 900);
    ctx.strokeStyle = "rgba(249,115,22,0.32)";
    ctx.beginPath();
    for (const [a, b, c] of triangles) {
      const pa = points[a];
      const pb = points[b];
      const pc = points[c];
      if (!pa || !pb || !pc || Math.max(pa.y, pb.y, pc.y) > lineY) continue;
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.lineTo(pc.x, pc.y);
      ctx.closePath();
    }
    ctx.stroke();

    for (const p of points) {
      if (p.y > lineY) continue;
      const fresh = Math.max(0, 1 - (lineY - p.y) / (span * 0.1));
      ctx.fillStyle = fresh > 0 ? `rgba(255,237,213,${0.75 + fresh * 0.25})` : "rgba(255,255,255,0.8)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, dot * (1 + fresh * 0.8), 0, Math.PI * 2);
      ctx.fill();
    }

    if (k < 1) {
      const band = span * 0.14;
      const glow = ctx.createLinearGradient(0, lineY - band, 0, lineY);
      glow.addColorStop(0, "rgba(249,115,22,0)");
      glow.addColorStop(1, "rgba(249,115,22,0.28)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, lineY - band, W, band);
      const edge = ctx.createLinearGradient(0, 0, W, 0);
      edge.addColorStop(0, "rgba(251,139,60,0)");
      edge.addColorStop(0.2, "rgba(251,139,60,0.95)");
      edge.addColorStop(0.8, "rgba(251,139,60,0.95)");
      edge.addColorStop(1, "rgba(251,139,60,0)");
      ctx.fillStyle = edge;
      ctx.fillRect(0, lineY - Math.max(1, W / 600), W, Math.max(2, W / 300));
    }
    ctx.globalAlpha = 1;

    if (t < SWEEP + HOLD + FADE) raf = requestAnimationFrame(frame);
    else {
      ctx.clearRect(0, 0, W, H);
      onDone();
    }
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
