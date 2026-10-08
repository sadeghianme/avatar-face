import type { RefObject } from "react";

import { MarkOutlines } from "@/features/avatars/components/mark/MarkOutlines";
import { type FaceMarks, GROUP_COLOURS, type Handle, type Pt } from "@/features/avatars/face-marks";
import { type Corner, LOUPE_FRAME, loupeCorner, loupeOrigin, loupeView } from "@/features/avatars/loupe";

// Inside the zoom, in its own (CSS) pixels: the dots, and the outlines' dash.
const LENS_DOT_PX = 4;
const LENS_DOT_ACTIVE_PX = 5.5;
const LENS_DASH_PX = 6;
// The crosshair's arms stop this far from the centre, so the pixel being
// placed stays visible between them.
const CROSSHAIR_GAP_PX = 7;
// Between the zoom and the caption hanging off it, in CSS pixels.
const CAPTION_GAP_PX = 4;

interface Size {
  width: number;
  height: number;
}

/** The zoom's three elements, painted between renders (placeLoupe). */
export interface LoupeRefs {
  box: RefObject<HTMLDivElement>;
  lens: RefObject<SVGSVGElement>;
  caption: RefObject<HTMLParagraphElement>;
}

/**
 * Put the zoom over `center` (image pixels) now, straight into the DOM, in
 * the corner of the photo away from it, with `text` hanging off it; hide
 * it when there is no center. The corner it took, kept by the caller so the
 * zoom does not hop between corners.
 */
export function placeLoupe(
  refs: LoupeRefs,
  center: Pt | null,
  text: string,
  at: { scale: number; canvas: Size; size: Size; inner: Size },
  corner: Corner | null
): Corner | null {
  const box = refs.box.current;
  const view = refs.lens.current;
  const caption = refs.caption.current;
  if (!box || !view || !caption) return corner;
  const { scale } = at;
  if (!center) {
    box.style.opacity = "0";
    return null;
  }
  const screen = { x: center.x * scale, y: center.y * scale };
  const next = loupeCorner(screen, at.canvas, at.size, corner);
  const origin = loupeOrigin(next, at.canvas, at.size);
  box.style.transform = `translate(${origin.x}px, ${origin.y}px)`;
  box.style.opacity = "1";
  view.setAttribute("viewBox", loupeView(center, scale, at.inner));
  caption.textContent = text;
  // Not `hidden`: line-clamp sets a display of its own, which wins over it.
  caption.style.display = text ? "" : "none";
  // The caption hangs off the zoom's side toward the middle of the photo,
  // never over what the zoom shows. As wide as the zoom, it cannot cover
  // the pointer either: that is always beside the zoom (loupeCorner).
  const gap = `${at.size.height + CAPTION_GAP_PX}px`;
  caption.style.top = next.top ? gap : "auto";
  caption.style.bottom = next.top ? "auto" : gap;
  return next;
}

/**
 * The zoom in the corner of the photo: three times the photo around a
 * point, its marks and outlines, a crosshair on that point, and a caption
 * naming the handle in question. Its place, what it shows and its caption
 * are painted straight into the DOM on each frame (useMarkCanvas); React
 * draws only what changes with the marks.
 */
export function MarkLoupe({
  refs,
  imageUrl,
  imageSize: [imgW, imgH],
  marks,
  handles,
  active,
  lensPx,
  size,
  inner,
}: {
  refs: LoupeRefs;
  imageUrl: string;
  imageSize: [number, number];
  marks: FaceMarks;
  handles: Handle[];
  /** The handle being moved, drawn larger. */
  active: string | null;
  /** One of the zoom's own pixels, in image pixels. */
  lensPx: number;
  size: Size;
  inner: Size;
}) {
  const midX = inner.width / 2;
  const midY = inner.height / 2;
  const arms = [
    [0, midY, midX - CROSSHAIR_GAP_PX, midY],
    [midX + CROSSHAIR_GAP_PX, midY, inner.width, midY],
    [midX, 0, midX, midY - CROSSHAIR_GAP_PX],
    [midX, midY + CROSSHAIR_GAP_PX, midX, inner.height],
  ];
  return (
    <div
      ref={refs.box}
      className="pointer-events-none absolute left-0 top-0 opacity-0 motion-safe:transition-opacity
        motion-safe:duration-100"
      style={{ width: size.width, height: size.height }}
      aria-hidden="true"
    >
      {/* The frame is inside the zoom's size, and what it shows fills
          the rest (loupeInner): exactly three times the photo. */}
      <div
        className="relative h-full w-full overflow-hidden border-white bg-gray-900 shadow-lg ring-1
          ring-black/40"
        style={{ borderRadius: 10, borderWidth: LOUPE_FRAME }}
      >
        <svg ref={refs.lens} className="block h-full w-full" preserveAspectRatio="none">
          <image href={imageUrl} x={0} y={0} width={imgW} height={imgH} preserveAspectRatio="none" />
          <MarkOutlines marks={marks} dash={LENS_DASH_PX * lensPx} />
          {handles.map((h) => {
            const p = h.at(marks);
            return (
              <circle
                key={h.id}
                cx={p.x}
                cy={p.y}
                r={(h.id === active ? LENS_DOT_ACTIVE_PX : LENS_DOT_PX) * lensPx}
                fill={GROUP_COLOURS[h.group]}
                stroke="white"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
        {/* The crosshair marks the zoom's centre: the pixel under the
            pointer, or the handle's exact spot. A dark line under a light
            one, so it shows on skin, fur and a white backdrop alike. */}
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${inner.width} ${inner.height}`}
          preserveAspectRatio="none"
        >
          {arms.map(([x1, y1, x2, y2], i) => (
            <g key={i}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="black" strokeOpacity={0.45} strokeWidth={3} />
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="white" strokeWidth={1} />
            </g>
          ))}
        </svg>
      </div>
      {/* What the pointer would pick up, or is moving, under the zoom (or
          over it, for a zoom at the bottom), not on it: a caption inside
          hid the half of what it named on a phone. Three lines hold the
          longest name on the narrowest zoom a phone shows. */}
      <p
        ref={refs.caption}
        style={{ display: "none" }}
        className="absolute inset-x-0 line-clamp-3 rounded-md bg-gray-900/85 px-1.5 py-1 text-center
          text-[11px] font-medium leading-tight text-white shadow"
      />
    </div>
  );
}
