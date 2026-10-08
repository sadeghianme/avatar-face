import { PROFILE_LIMITS, type ReferenceProfile } from "@liveface/embed/mouth";

import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import type { MouthPanelState } from "@/features/avatars/hooks/useMouthPanel";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/types";

/** Lip projection belongs to the older geometric prototype only. */
const SLIDERS: (keyof ReferenceProfile)[] = ["teethScale", "teethY", "warmth", "jawRange"];
const LABELS: Record<keyof ReferenceProfile, MessageKey> = {
  teethScale: "mouthTeethSize",
  teethY: "mouthTeethPosition",
  warmth: "mouthWarmth",
  lipProjection: "mouthTeethSize",
  jawRange: "mouthJaw",
};

/** How the photographic mouth is fitted: previewed while dragged, saved
 *  when let go (each save is a draft edit); Reset saves the defaults. */
export function MouthSliders({ panel }: { panel: MouthPanelState }) {
  const { t } = useT();
  return (
    <>
      {SLIDERS.map((key) => {
        const [min, max, step] = PROFILE_LIMITS[key];
        return (
          <Slider
            key={key}
            id={`mouth-${key}`}
            label={t(LABELS[key])}
            min={min}
            max={max}
            step={step}
            value={panel.profile[key]}
            onChange={(value) => panel.slide(key, value)}
            onPointerUp={panel.release}
            onKeyUp={panel.release}
          />
        );
      })}
      <Button variant="secondary" disabled={panel.busy} onClick={panel.reset}>
        {t("mouthReset")}
      </Button>
    </>
  );
}
