import { useId } from "react";

import portrait from "@/assets/demo/portrait.webp";
import type { AvatarModel, Look } from "@/features/avatars/wizard";

/**
 * The wizard's pictures: one character per model, drawn in each look, so
 * the choice of style is shown rather than described. A person's
 * "realistic" is a photograph (the Reference avatar's own portrait, a
 * fictional face made for the lab); everything else is drawn here, in
 * SVG, so it is crisp at any size and weighs nothing.
 *
 * Decorative: every picture is aria-hidden, the card it sits in carries
 * the words.
 */

const INK = "#2b2118";

interface Palette {
  skin: string;
  skinShade: string;
  hair: string;
  hairLight: string;
  shirt: string;
  shirtShade: string;
  fur: string;
  furShade: string;
  ear: string;
  muzzle: string;
}

const PALETTE: Palette = {
  skin: "#f1c09b",
  skinShade: "#d9956c",
  hair: "#3b2a22",
  hairLight: "#6b4a3a",
  shirt: "#f97316",
  shirtShade: "#c2540c",
  fur: "#dea46a",
  furShade: "#b87a40",
  ear: "#8f5a2e",
  muzzle: "#f6e6cf",
};

/** A face in one look. viewBox 0 0 100 100, the head centred and the
 * shoulders cut by the bottom edge, as the avatar's own pictures are. */
export function Face({ model, look, className }: { model: AvatarModel; look: Look; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const g = (name: string) => `${uid}-${name}`;
  const cartoon = look === "cartoon";
  const animated = look === "animation";
  const stroke = cartoon ? { stroke: INK, strokeWidth: 2.2, strokeLinejoin: "round" as const } : {};
  const fill = (flat: string, gradient: string) => (cartoon ? flat : `url(#${g(gradient)})`);
  const p = PALETTE;

  const defs = (
    <defs>
      <radialGradient id={g("skin")} cx="42%" cy="36%" r="70%">
        <stop offset="0" stopColor={animated ? "#ffd9bd" : "#f6caa6"} />
        <stop offset="0.65" stopColor={p.skin} />
        <stop offset="1" stopColor={p.skinShade} />
      </radialGradient>
      <linearGradient id={g("hair")} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={animated ? "#8a5f47" : p.hairLight} />
        <stop offset="1" stopColor={p.hair} />
      </linearGradient>
      <linearGradient id={g("shirt")} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={animated ? "#fb8b3c" : p.shirt} />
        <stop offset="1" stopColor={p.shirtShade} />
      </linearGradient>
      <radialGradient id={g("fur")} cx="45%" cy="38%" r="72%">
        <stop offset="0" stopColor={animated ? "#f6c38b" : "#e8b27a"} />
        <stop offset="0.7" stopColor={p.fur} />
        <stop offset="1" stopColor={p.furShade} />
      </radialGradient>
      <linearGradient id={g("ear")} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#a86c3a" />
        <stop offset="1" stopColor={p.ear} />
      </linearGradient>
      <radialGradient id={g("muzzle")} cx="50%" cy="35%" r="70%">
        <stop offset="0" stopColor="#fffaf2" />
        <stop offset="1" stopColor="#e9d3b4" />
      </radialGradient>
      <radialGradient id={g("shine")} cx="50%" cy="50%" r="50%">
        <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
        <stop offset="1" stopColor="#fff" stopOpacity="0" />
      </radialGradient>
      {/* Realistic fur: soft ragged edges and a fine grain over the paint. */}
      <filter id={g("fur")+"-tex"} x="-6%" y="-6%" width="112%" height="112%">
        <feTurbulence type="fractalNoise" baseFrequency="2.2" numOctaves="2" seed="7" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.2" xChannelSelector="R" yChannelSelector="G" result="rough" />
        <feColorMatrix in="noise" type="luminanceToAlpha" result="mask" />
        <feComponentTransfer in="mask" result="grain">
          <feFuncA type="linear" slope="0.22" intercept="-0.02" />
        </feComponentTransfer>
        <feFlood floodColor="#3a2412" result="ink" />
        <feComposite in="ink" in2="grain" operator="in" result="specks" />
        <feComposite in="specks" in2="rough" operator="in" result="fur" />
        <feMerge>
          <feMergeNode in="rough" />
          <feMergeNode in="fur" />
        </feMerge>
      </filter>
    </defs>
  );

  // Eyes: dots with a glint when drawn, big glossy eyes when animated.
  const eye = (cx: number, cy: number, iris: string) =>
    animated ? (
      <g key={cx}>
        <ellipse cx={cx} cy={cy} rx="4.6" ry="5.2" fill="#fff" />
        <circle cx={cx} cy={cy + 0.6} r="3.4" fill={iris} />
        <circle cx={cx} cy={cy + 0.6} r="1.7" fill="#1a120d" />
        <circle cx={cx - 1.2} cy={cy - 0.8} r="1.1" fill="#fff" />
      </g>
    ) : cartoon ? (
      <g key={cx}>
        <ellipse cx={cx} cy={cy} rx="3" ry="3.4" fill="#fff" stroke={INK} strokeWidth="1.6" />
        <circle cx={cx} cy={cy + 0.4} r="1.7" fill={INK} />
      </g>
    ) : (
      <g key={cx}>
        <ellipse cx={cx} cy={cy} rx="3.2" ry="2.1" fill="#fbf7f2" />
        <circle cx={cx} cy={cy} r="1.7" fill={iris} />
        <circle cx={cx} cy={cy} r="0.8" fill="#140d09" />
        <circle cx={cx - 0.6} cy={cy - 0.6} r="0.45" fill="#fff" />
      </g>
    );

  if (model === "human") {
    return (
      <svg viewBox="0 0 100 100" className={className} aria-hidden="true" focusable="false">
        {defs}
        {/* shoulders and neck */}
        <path d="M12 100 C14 84 29 75 50 75 C71 75 86 84 88 100 Z" fill={fill(p.shirt, "shirt")} {...stroke} />
        <path d="M43 60 L43 73 C46 77 54 77 57 73 L57 60 Z" fill={fill(p.skinShade, "skin")} {...stroke} />
        {/* hair behind */}
        <path d="M28 46 C24 22 40 12 52 13 C67 14 78 26 73 50 C75 60 73 68 67 71 C62 73 60 66 58 64 L42 64 C40 66 38 73 33 71 C27 68 25 58 28 46 Z" fill={fill(p.hair, "hair")} {...stroke} />
        {/* ears and head */}
        <ellipse cx="30.5" cy="47" rx="3.6" ry="5" fill={fill(p.skin, "skin")} {...stroke} />
        <ellipse cx="69.5" cy="47" rx="3.6" ry="5" fill={fill(p.skin, "skin")} {...stroke} />
        <ellipse cx="50" cy={animated ? 45 : 44} rx={animated ? 20 : 19} ry={animated ? 22 : 22.5} fill={fill(p.skin, "skin")} {...stroke} />
        {/* fringe */}
        <path d="M31 40 C32 26 44 21 53 22 C63 23 70 30 69.5 40 C64 33 57 30 49 31 C41 32 35 35 31 40 Z" fill={fill(p.hair, "hair")} {...stroke} />
        {/* brows */}
        <path d="M39 40.5 Q43 38.6 47 40" stroke={p.hair} strokeWidth={cartoon ? 2 : 1.4} fill="none" strokeLinecap="round" />
        <path d="M53 40 Q57 38.6 61 40.5" stroke={p.hair} strokeWidth={cartoon ? 2 : 1.4} fill="none" strokeLinecap="round" />
        {eye(43, animated ? 46.5 : 45.5, "#6b4a2b")}
        {eye(57, animated ? 46.5 : 45.5, "#6b4a2b")}
        {/* nose and mouth (closed, relaxed) */}
        <path d="M50 48 Q51.6 52.5 49 53.4" stroke={cartoon ? INK : p.skinShade} strokeWidth={cartoon ? 1.6 : 1.3} fill="none" strokeLinecap="round" />
        <path d={animated ? "M44.5 57.5 Q50 61.5 55.5 57.5" : "M45 57.5 Q50 60 55 57.5"} stroke={cartoon ? INK : "#b5654f"} strokeWidth={cartoon ? 1.8 : 1.6} fill="none" strokeLinecap="round" />
        {animated && <ellipse cx="44" cy="30" rx="10" ry="6" fill={`url(#${g("shine")})`} />}
        {!cartoon && <ellipse cx="38" cy="53" rx="3.4" ry="2" fill="#f08a78" opacity={animated ? 0.45 : 0.2} />}
        {!cartoon && <ellipse cx="62" cy="53" rx="3.4" ry="2" fill="#f08a78" opacity={animated ? 0.45 : 0.2} />}
      </svg>
    );
  }

  const realistic = look === "realistic";
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true" focusable="false">
      {defs}
      <g filter={realistic ? `url(#${g("fur")}-tex)` : undefined}>
      {/* chest */}
      <path d="M18 100 C20 80 33 70 50 70 C67 70 80 80 82 100 Z" fill={fill(p.fur, "fur")} {...stroke} />
      <path d="M38 100 C39 86 44 78 50 78 C56 78 61 86 62 100 Z" fill={fill(p.muzzle, "muzzle")} {...(cartoon ? { stroke: INK, strokeWidth: 1.6 } : {})} />
      {/* ears */}
      <path d="M31 30 C19 31 14 50 20 64 C24 67 29 62 31 56 C33 47 35 38 36 33 Z" fill={fill(p.ear, "ear")} {...stroke} />
      <path d="M69 30 C81 31 86 50 80 64 C76 67 71 62 69 56 C67 47 65 38 64 33 Z" fill={fill(p.ear, "ear")} {...stroke} />
      {/* head */}
      <ellipse cx="50" cy="47" rx={animated ? 22.5 : 21.5} ry={animated ? 22 : 21} fill={fill(p.fur, "fur")} {...stroke} />
      {/* blaze and muzzle */}
      <path d="M47 27 C48 34 47 40 45 46 L55 46 C53 40 52 34 53 27 C51 26 49 26 47 27 Z" fill={fill(p.muzzle, "muzzle")} opacity={cartoon ? 1 : 0.9} />
      <ellipse cx="50" cy="58" rx="12.5" ry="9.5" fill={fill(p.muzzle, "muzzle")} {...(cartoon ? { stroke: INK, strokeWidth: 1.8 } : {})} />
      {eye(41.5, animated ? 45 : 45, "#5a3616")}
      {eye(58.5, animated ? 45 : 45, "#5a3616")}
      {/* nose and closed mouth */}
      <path d="M45.6 52.4 C45.6 49.8 54.4 49.8 54.4 52.4 C54.4 55 51.8 56.6 50 56.6 C48.2 56.6 45.6 55 45.6 52.4 Z" fill="#241a14" />
      {!cartoon && <ellipse cx="48.6" cy="51.6" rx="1.6" ry="0.9" fill="#fff" opacity="0.5" />}
      <path d="M50 56.6 L50 60 M44.8 60.6 Q50 64.4 55.2 60.6" stroke={INK} strokeWidth={cartoon ? 1.8 : 1.3} fill="none" strokeLinecap="round" />
      {realistic && (
        // Fur direction: short strokes fanning from the muzzle.
        <g stroke="#7a4a22" strokeWidth="0.5" strokeLinecap="round" opacity="0.45" fill="none">
          <path d="M36 38 l-2 -3 M39 34 l-1 -3.5 M61 34 l1 -3.5 M64 38 l2 -3 M33 44 l-3 -1 M67 44 l3 -1 M35 53 l-3 1 M65 53 l3 1 M40 62 l-2 3 M60 62 l2 3" />
          <path d="M24 44 l-1.5 4 M22 52 l-1 4 M76 44 l1.5 4 M78 52 l1 4 M30 82 l-2 5 M70 82 l2 5 M40 76 l-1 4 M60 76 l1 4" />
        </g>
      )}
      {animated && <ellipse cx="44" cy="33" rx="10" ry="6" fill={`url(#${g("shine")})`} />}
      </g>
    </svg>
  );
}

/** A look's thumbnail: a person's realistic is a photograph. */
export function LookPicture({ model, look, className }: { model: AvatarModel; look: Look; className?: string }) {
  if (model === "human" && look === "realistic") {
    return (
      <img
        src={portrait}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={`${className ?? ""} object-cover object-[50%_30%]`}
      />
    );
  }
  // Drawn a little closer than the model cards: the face is what a look
  // changes, so it fills the thumbnail.
  return <Face model={model} look={look} className={`${className ?? ""} origin-bottom translate-y-[4%] scale-[1.12]`} />;
}

/** The backdrop every look sits on in the wizard: warm in light, deep in
 * dark, and the same under a photo and a drawing so they compare. */
export const PICTURE_BACKDROP =
  "bg-gradient-to-b from-brand-50 to-orange-100/70 dark:from-[#241a12] dark:to-[#1a1410]";

/** A checkerboard, for pictures whose background was taken off. */
export const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, rgba(127,127,127,.13) 25%, transparent 25%), linear-gradient(-45deg, rgba(127,127,127,.13) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(127,127,127,.13) 75%), linear-gradient(-45deg, transparent 75%, rgba(127,127,127,.13) 75%)",
  backgroundSize: "20px 20px",
  backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0",
};
