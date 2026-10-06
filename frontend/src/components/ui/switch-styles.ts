/**
 * A switch's track and thumb, on and off, in its two sizes. Framework-free,
 * so `npm test` checks that a press flips both. The track's `before:` box
 * is the tap area the phone pass gave every switch: 64×44 around a
 * 44×24 (sm) or 48×28 (md) track.
 */
export type SwitchSize = "sm" | "md";

const TRACK_BASE = [
  "relative shrink-0 rounded-full transition-colors before:absolute before:content-['']",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
  "disabled:cursor-not-allowed disabled:opacity-60",
].join(" ");

const LOOK: Record<SwitchSize, { track: string; off: string; thumb: string; thumbOn: string; thumbOff: string }> = {
  // Beside a line of text (the public link).
  sm: {
    track: "mt-0.5 h-6 w-11 before:-inset-2.5",
    off: "bg-gray-300 dark:bg-gray-600",
    thumb: "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
    thumbOn: "start-[22px]",
    thumbOff: "start-0.5",
  },
  // A setting of its own (the organization's AI switch).
  md: {
    track: "inline-flex h-7 w-12 items-center before:-inset-2",
    off: "bg-gray-300 dark:bg-white/20",
    thumb: "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform motion-reduce:transition-none",
    thumbOn: "translate-x-6 rtl:-translate-x-6",
    thumbOff: "translate-x-1 rtl:-translate-x-1",
  },
};

export function switchClasses(checked: boolean, size: SwitchSize = "md"): { track: string; thumb: string } {
  const look = LOOK[size];
  return {
    track: `${TRACK_BASE} ${look.track} ${checked ? "bg-brand-600" : look.off}`,
    thumb: `${look.thumb} ${checked ? look.thumbOn : look.thumbOff}`,
  };
}
