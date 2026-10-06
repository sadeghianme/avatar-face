import { DEFAULT_TUNING, type EngineTuning, type SpeechPlayer } from "@liveface/embed";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";

interface SliderDef {
  key: keyof EngineTuning;
  labelKey: string;
  min: number;
  max: number;
  step: number;
  /** Hidden for 3D models (teeth are real geometry there). */
  photoOnly?: boolean;
}

const SLIDERS: SliderDef[] = [
  { key: "mouthOpen", labelKey: "tuneMouthOpen", min: 0.2, max: 2, step: 0.05 },
  { key: "smoothness", labelKey: "tuneSmoothness", min: 0.3, max: 2, step: 0.05 },
  { key: "headMotion", labelKey: "tuneHeadMotion", min: 0, max: 2, step: 0.05 },
  { key: "teethThreshold", labelKey: "tuneTeethThreshold", min: 0.2, max: 0.8, step: 0.01, photoOnly: true },
  { key: "teethHeight", labelKey: "tuneTeethHeight", min: 0.02, max: 0.15, step: 0.005, photoOnly: true },
];

const storageKey = (avatarId: string) => `liveface.tuning.${avatarId}`;

export function loadTuning(avatarId: string): EngineTuning {
  try {
    const raw = localStorage.getItem(storageKey(avatarId));
    return raw ? { ...DEFAULT_TUNING, ...JSON.parse(raw) } : { ...DEFAULT_TUNING };
  } catch {
    return { ...DEFAULT_TUNING };
  }
}

/**
 * Live animation sliders, the avatar page's Advanced section: they write
 * engine.tuning (applied on the next frame — no re-render of the preview)
 * and persist per avatar.
 */
export function TuningPanel({
  engine,
  avatarId,
  is3d = false,
}: {
  engine: SpeechPlayer | null;
  avatarId: string;
  is3d?: boolean;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<EngineTuning>(() => loadTuning(avatarId));

  // The engine follows the values: a new engine gets the persisted ones, a
  // slider its new one (a handful of numbers, assigned again each time).
  useEffect(() => {
    if (engine && "tuning" in engine) {
      Object.assign((engine as unknown as { tuning: EngineTuning }).tuning, values);
    }
  }, [engine, values]);

  const update = (key: keyof EngineTuning, value: number) => {
    const next = { ...values, [key]: value };
    setValues(next);
    localStorage.setItem(storageKey(avatarId), JSON.stringify(next));
  };

  const reset = () => {
    localStorage.removeItem(storageKey(avatarId));
    setValues({ ...DEFAULT_TUNING });
  };

  return (
    <div className="flex flex-col gap-3">
      {SLIDERS.filter((s) => !(is3d && s.photoOnly)).map((slider) => (
        <Slider
          key={slider.key}
          look="compact"
          id={`tune-${slider.key}`}
          label={t(slider.labelKey)}
          min={slider.min}
          max={slider.max}
          step={slider.step}
          value={values[slider.key]}
          onChange={(value) => update(slider.key, value)}
        />
      ))}
      <Button variant="secondary" size="sm" className="self-end" onClick={reset}>
        {t("tuneReset")}
      </Button>
    </div>
  );
}
