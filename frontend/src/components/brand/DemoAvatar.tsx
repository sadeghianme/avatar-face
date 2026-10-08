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
import { Button } from "@/components/ui/Button";
import { loadImage } from "@/lib/image";

import type { DemoDirector, DemoLine, DemoSnapshot } from "./demoDirector";
import { delay, rampMotion, runScan } from "./demoScan";
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
      const created = new AvatarEngine(canvas, rig, texture, { fullPhoto: true, debug: true });
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
        <Button
          variant="overlay"
          icon="playTriangle"
          onClick={() => setArmed(true)}
          className="absolute inset-0 m-auto flex h-14 w-fit gap-2.5 bg-black/60 px-5 hover:bg-black/75"
        >
          {playLabel}
        </Button>
      )}
    </div>
  );
}
