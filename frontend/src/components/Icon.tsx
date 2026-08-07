/**
 * Line icons on a 24px grid.
 *
 * Each icon is a list of shapes rather than one crammed path — the previous
 * single-path versions produced a mangled gear and a smiley standing in for
 * "avatars", because a whole glyph squeezed into one `d` string cannot have
 * separate closed subpaths without becoming unreadable to write and to edit.
 *
 * Geometry follows the Lucide conventions: 24x24 box, 2px visual margin,
 * 1.6 stroke, round caps and joins, everything inheriting `currentColor` so
 * an icon never fights the palette.
 */
export type Shape =
  | { d: string }
  | { circle: [number, number, number] }
  | { rect: [number, number, number, number, number] };

/** Exported so the set can be enumerated (dev icon sheet, tests). */
export const ICONS: Record<string, Shape[]> = {
  // Avatars — a portrait in frame, which is literally what the product makes.
  faces: [
    { rect: [3, 3, 18, 18, 4] },
    { circle: [12, 10, 3] },
    { d: "M6.5 19.5a6 6 0 0 1 11 0" },
  ],
  users: [
    { circle: [9, 8, 3.2] },
    { d: "M2.5 20a6.5 6.5 0 0 1 13 0" },
    { d: "M16.5 5.3a3.2 3.2 0 0 1 0 5.6M18 14.4a6.5 6.5 0 0 1 3.5 5.6" },
  ],
  key: [
    { circle: [7.5, 15.5, 3.5] },
    { d: "M10 13 20.5 2.5M18 5l2.5 2.5M15.5 7.5 18 10" },
  ],
  // Settings — sliders, not a gear. A gear at 18px is a smudge.
  settings: [
    { d: "M4 6h10M18 6h2M4 12h3M11 12h9M4 18h8M16 18h4" },
    { circle: [16, 6, 2] },
    { circle: [9, 12, 2] },
    { circle: [14, 18, 2] },
  ],
  plus: [{ d: "M12 5.5v13M5.5 12h13" }],
  check: [{ d: "M20 6.5 9.5 17 4 11.5" }],
  clock: [{ circle: [12, 12, 9] }, { d: "M12 7.5V12l3 1.8" }],
  chart: [{ d: "M3.5 3.5v17h17" }, { d: "M7.5 16v-3M12 16V8.5M16.5 16v-5" }],
  sun: [
    { circle: [12, 12, 4] },
    { d: "M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" },
  ],
  moon: [{ d: "M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.6 6.6 0 0 0 10 10Z" }],
  menu: [{ d: "M3.5 7h17M3.5 12h17M3.5 17h17" }],
  chevron: [{ d: "m9.5 6 6 6-6 6" }],
  arrow: [{ d: "M4 12h15M13 6l6 6-6 6" }],
  trash: [
    { d: "M4 6.5h16M9.5 6.5V4.5h5v2" },
    { d: "M6.5 6.5 7.5 20a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1l1-13.5" },
  ],
};

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  className = "h-5 w-5",
  strokeWidth = 1.6,
}: {
  name: IconName;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ICONS[name].map((shape, i) =>
        "circle" in shape ? (
          <circle key={i} cx={shape.circle[0]} cy={shape.circle[1]} r={shape.circle[2]} />
        ) : "rect" in shape ? (
          <rect
            key={i}
            x={shape.rect[0]}
            y={shape.rect[1]}
            width={shape.rect[2]}
            height={shape.rect[3]}
            rx={shape.rect[4]}
          />
        ) : (
          <path key={i} d={shape.d} />
        )
      )}
    </svg>
  );
}
