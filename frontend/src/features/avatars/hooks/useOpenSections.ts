import { useState } from "react";

/**
 * The avatar page's folded sections. Framing opens by itself: it is the
 * one the preview answers to (drag to pan). The rest open on demand, and
 * what was opened is kept for the next avatar (a member tuning mouths
 * does not unfold Mouth on every page).
 */
export type SectionId = "scene" | "mouth" | "share" | "embed" | "tuning";

const OPEN_BY_DEFAULT: Record<SectionId, boolean> = {
  scene: true,
  mouth: false,
  share: false,
  embed: false,
  tuning: false,
};
const OPEN_KEY = "liveface.avatarPage.open";

function loadOpen(): Record<SectionId, boolean> {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    return raw
      ? { ...OPEN_BY_DEFAULT, ...(JSON.parse(raw) as Partial<Record<SectionId, boolean>>) }
      : { ...OPEN_BY_DEFAULT };
  } catch {
    return { ...OPEN_BY_DEFAULT };
  }
}

/** Which sections are open, kept in localStorage; `reveal` opens one (a link to it). */
export function useOpenSections() {
  const [open, setOpen] = useState<Record<SectionId, boolean>>(loadOpen);
  const toggle = (id: SectionId) =>
    setOpen((current) => {
      const next = { ...current, [id]: !current[id] };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // best effort: the defaults next time
      }
      return next;
    });
  const reveal = (id: SectionId) => {
    if (!open[id]) toggle(id);
  };
  return { open, toggle, reveal };
}
