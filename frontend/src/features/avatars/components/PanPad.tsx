import type { KeyboardEvent } from "react";

import { IconButton } from "@/components/ui/IconButton";
import { useT } from "@/i18n";

/**
 * The framing's position pad: focused, the arrow keys move the picture
 * (Shift: further, `onKey`); its four buttons do the same for a pointer
 * (`onNudge`), with the position read out in the middle. A keyboard surface
 * (docs/frontend-ui.md, "Exceptions"): it takes the focus and the keys
 * itself.
 */
export function PanPad({
  pan,
  labelledBy,
  onKey,
  onNudge,
}: {
  pan: { x: number; y: number };
  labelledBy: string;
  onKey: (event: KeyboardEvent) => void;
  onNudge: (key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight") => void;
}) {
  const { t } = useT();
  const arrow = (key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight", label: string, glyph: string) => (
    <IconButton
      variant="secondary"
      label={label}
      icon={<span aria-hidden="true">{glyph}</span>}
      onClick={() => onNudge(key)}
    />
  );
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby="scene-pan-value"
      tabIndex={0}
      onKeyDown={onKey}
      className="inline-grid grid-cols-3 gap-1 rounded-xl border border-gray-200 p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-line"
    >
      <span />
      {arrow("ArrowUp", t("scenePanUp"), "↑")}
      <span />
      {arrow("ArrowLeft", t("scenePanLeft"), "←")}
      <span
        id="scene-pan-value"
        className="grid place-items-center font-mono text-[11px] tabular-nums text-gray-500 dark:text-gray-400"
      >
        {pan.x.toFixed(2)}, {pan.y.toFixed(2)}
      </span>
      {arrow("ArrowRight", t("scenePanRight"), "→")}
      <span />
      {arrow("ArrowDown", t("scenePanDown"), "↓")}
      <span />
    </div>
  );
}
