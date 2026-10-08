import { useEffect, useRef } from "react";

import type { DemoDirector } from "./demoDirector";
import { useReducedMotion } from "./useReducedMotion";

/**
 * Per-frame level bars for the speaking voice, driven by the director's
 * mouth openness. Written to the DOM directly — sixty React renders a second
 * for a decoration would cost more than the avatar itself.
 */
export function VoiceMeter({
  director,
  bars = 7,
  className = "",
}: {
  director: DemoDirector;
  bars?: number;
  className?: string;
}) {
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
        <span
          key={i}
          className="h-full w-[3px] origin-center rounded-full bg-brand-500"
          style={{ transform: "scaleY(0.14)" }}
        />
      ))}
    </div>
  );
}
