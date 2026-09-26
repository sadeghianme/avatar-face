import type { AvatarEngine, Rig } from "@liveface/embed";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import motionUrl from "@/assets/demo/mouth-motion.json?url";
import oralRigUrl from "@/assets/demo/oral.rig.json?url";
import oralUrl from "@/assets/demo/oral.webp";
import portraitUrl from "@/assets/demo/portrait.webp";
import voice1 from "@/assets/demo/voice-1.m4a?url";
import voice2 from "@/assets/demo/voice-2.m4a?url";
import voice3 from "@/assets/demo/voice-3.m4a?url";
import voice4 from "@/assets/demo/voice-4.m4a?url";
import voice5 from "@/assets/demo/voice-5.m4a?url";
import { Icon } from "@/components/ui/Icon";
import { loadImage } from "@/lib/image";

import type { DemoDirector, DemoLine, DemoSnapshot } from "./demoDirector";
import { useReducedMotion } from "./useReducedMotion";

/** The demo portrait: a fictional person, generated for this purpose (see
 *  docs/reference-avatar-lab.md for provenance). Never a real customer. */
export const DEMO_PORTRAIT = portraitUrl;
const VOICES = [voice1, voice2, voice3, voice4, voice5];

/** Subscribe a component to the director's discrete state (line, word...). */
export function useDemo(director: DemoDirector): DemoSnapshot {
  return useSyncExternalStore(director.subscribe, director.getSnapshot, director.getSnapshot);
}

/**
 * The real avatar engine, booted behind an instant poster.
 *
 * The poster is the same photo the engine animates, framed identically
 * (fullPhoto on a square photo), so when the engine takes over nothing
 * jumps — the picture simply starts breathing. Everything heavy arrives
 * after first paint and in order of need: engine, then (showcase only) the
 * scan intro, the photographic mouth and the recorded lines.
 *
 * `idle` is the calm variant for the sign-in page: alive, silent, no chrome.
 */
export function DemoAvatar({
  mode,
  director,
  label,
  playLabel,
  className = "",
}: {
  mode: "showcase" | "idle";
  director?: DemoDirector;
  label: string;
  playLabel?: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  // Under reduced motion nothing moves until the visitor asks for it.
  const [armed, setArmed] = useState(false);
  const [live, setLive] = useState(false);
  const boot = !reduced || armed;

  useEffect(() => {
    if (!boot) return;
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    const container = box.current;
    if (!canvas || !overlay || !container) return;

    let disposed = false;
    let engine: AvatarEngine | null = null;
    let cancelScan: (() => void) | null = null;
    let detachMouth: (() => void) | null = null;
    const cleanups: (() => void)[] = [];

    // Backing store sized to the box, capped: a phone does not need a
    // 2000px canvas, and every pixel is paid for on every frame.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = container.getBoundingClientRect().width || 480;
    const side = Math.round(Math.min(1080, Math.max(360, cssWidth * dpr)));
    canvas.width = canvas.height = overlay.width = overlay.height = side;

    const start = async () => {
      const [{ AvatarEngine }, rigModule, texture] = await Promise.all([
        import("@liveface/embed"),
        import("@/assets/demo/rig.json"),
        loadImage(portraitUrl),
      ]);
      if (disposed) return;
      const rig = rigModule.default as unknown as Rig;
      const created = new AvatarEngine(canvas, rig, texture, { fullPhoto: true });
      engine = created;
      const scanning = mode === "showcase" && !reduced;
      if (scanning) {
        // Hold still while the rig is traced, so the dots sit on the face.
        created.tuning.headMotion = 0;
        created.tuning.bodyMotion = 0;
      }
      setLive(true);

      let inView = true;
      const apply = () => {
        const visible = inView && document.visibilityState === "visible";
        created.setActive(visible);
        director?.setVisible(visible);
      };
      const observer = new IntersectionObserver(
        ([entry]) => {
          inView = entry.isIntersecting;
          apply();
        },
        { threshold: 0.05 }
      );
      observer.observe(container);
      document.addEventListener("visibilitychange", apply);
      cleanups.push(() => {
        observer.disconnect();
        document.removeEventListener("visibilitychange", apply);
      });

      if (mode !== "showcase" || !director) return;
      const linesModule = await import("@/assets/demo/lines.json");
      if (disposed) return;
      director.attach(created, linesModule.default as unknown as DemoLine[], VOICES);

      // The photographic mouth, progressively; the classic one works meanwhile.
      // It brings its own teeth photo (the Reference's, as the demo always
      // showed), so the loader never looks for the standard teeth: those are
      // served beside the API's motion, not beside this bundled copy of it.
      const mouth = import("@liveface/embed/mouth")
        .then(({ attachAvatarMouth }) =>
          attachAvatarMouth(
            created,
            { renderer: "continuous", oral: { image_url: oralUrl, rig_url: oralRigUrl } },
            motionUrl
          )
        )
        .then((attached) => {
          if (disposed) attached.detach();
          else detachMouth = attached.detach;
        })
        .catch(() => undefined);

      const traced = new Promise<void>((resolve) => {
        if (!scanning) {
          director.markRigged();
          resolve();
          return;
        }
        director.setPhase("scanning");
        cancelScan = runScan(overlay, created.landmarks(), rig.triangles as unknown as number[][], () => {
          director.markRigged();
          resolve();
        });
      });
      await Promise.all([traced, Promise.race([mouth, delay(4000)])]);
      if (disposed) return;
      if (scanning) rampMotion(created, 1100);
      director.setPhase("ready");
      window.setTimeout(() => !disposed && director.start(0), scanning ? 600 : 150);
    };
    start().catch(() => {
      if (!disposed) director?.setPhase("unavailable");
    });

    return () => {
      disposed = true;
      cancelScan?.();
      detachMouth?.();
      cleanups.forEach((fn) => fn());
      director?.detach();
      engine?.destroy();
    };
  }, [boot, mode, director, reduced]);

  return (
    <div ref={box} className={`relative aspect-square overflow-hidden ${className}`}>
      <img
        src={portraitUrl}
        alt=""
        width={1024}
        height={1024}
        decoding="async"
        {...{ fetchpriority: mode === "showcase" ? "high" : "auto" }}
        className="absolute inset-0 h-full w-full object-cover"
      />
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        className={`absolute inset-0 h-full w-full transition-opacity duration-700 ${live ? "opacity-100" : "opacity-0"}`}
      />
      <canvas ref={overlayRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
      {mode === "showcase" && reduced && !armed && (
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="absolute inset-0 m-auto flex h-14 w-fit items-center gap-2.5 rounded-full bg-black/60 px-5 text-sm font-medium text-white backdrop-blur-md transition hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <Icon name="playTriangle" className="h-4 w-4" />
          {playLabel}
        </button>
      )}
    </div>
  );
}

/**
 * Per-frame level bars for the speaking voice, driven by the director's
 * mouth openness. Written to the DOM directly — sixty React renders a second
 * for a decoration would cost more than the avatar itself.
 */
export function VoiceMeter({ director, bars = 7, className = "" }: { director: DemoDirector; bars?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    let level = 0;
    const tick = (now: number) => {
      level += (director.target - level) * (director.target > level ? 0.35 : 0.18);
      const nodes = ref.current?.children;
      if (nodes) {
        for (let i = 0; i < nodes.length; i++) {
          const wobble = 0.55 + 0.45 * Math.sin(now / 105 + i * 1.7);
          (nodes[i] as HTMLElement).style.transform = `scaleY(${(0.14 + level * wobble * 0.86).toFixed(3)})`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [director, reduced]);
  return (
    <div ref={ref} className={`flex h-5 items-center gap-[3px] ${className}`} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} className="h-full w-[3px] origin-center rounded-full bg-brand-500" style={{ transform: "scaleY(0.14)" }} />
      ))}
    </div>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Ease head and body motion in after the scan, instead of switching on. */
function rampMotion(engine: AvatarEngine, ms: number): void {
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
function runScan(
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
