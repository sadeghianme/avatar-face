import { PROFILE_LIMITS, type ReferenceProfile } from "@liveface/embed/mouth/reference-mouth-model";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Slider } from "@/components/ui/Slider";

const LABELS: Record<keyof ReferenceProfile, string> = {
  teethScale: "referenceTeethSize",
  teethY: "referenceTeethPosition",
  warmth: "referenceWarmth",
  lipProjection: "referenceProjection",
  jawRange: "referenceJaw",
};

export function ReferenceFitControls({
  profile,
  update,
  save,
  reset,
  status,
  photographic = false,
  continuous = false,
}: {
  photographic?: boolean;
  continuous?: boolean;
  profile: ReferenceProfile;
  update: (next: ReferenceProfile) => void;
  save: () => void;
  reset: () => void;
  status: "idle" | "saved" | "failed";
}) {
  const { t } = useTranslation();
  return (
    <Card as="section" className="space-y-4">
      <div>
        <h3 className="font-semibold">{t("referenceFit")}</h3>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          {t(photographic ? "referencePhotographicFit" : "referenceFitHint")}
        </p>
      </div>
      {(Object.keys(PROFILE_LIMITS) as (keyof ReferenceProfile)[])
        .filter((key) => !(continuous || photographic) || key !== "lipProjection")
        .map((key) => {
          const [min, max, step] = PROFILE_LIMITS[key];
          return (
            <Slider
              key={key}
              id={`reference-${key}`}
              label={t(LABELS[key])}
              min={min}
              max={max}
              step={step}
              value={profile[key]}
              onChange={(value) => update({ ...profile, [key]: value })}
            />
          );
        })}
      <div className="flex flex-wrap gap-2">
        <Button onClick={save}>{t("referenceSave")}</Button>
        <Button variant="secondary" onClick={reset}>
          {t("referenceReset")}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-gray-500" role="status">
        {t(status === "saved" ? "referenceSaved" : status === "failed" ? "referenceSaveFailed" : "referenceLocalOnly")}
      </p>
    </Card>
  );
}
