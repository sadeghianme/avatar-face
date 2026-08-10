import { DEFAULT_TUNING, type EngineTuning, type SpeechPlayer } from "@liveface/embed";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "./Icon";

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
 * Live animation sliders. Mutates engine.tuning directly (applied on the
 * next frame — no re-render of the preview) and persists per avatar.
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
  const [open, setOpen] = useState(false);

  // Apply persisted values whenever a (new) engine arrives.
  useEffect(() => {
    if (engine && "tuning" in engine) {
      Object.assign((engine as unknown as { tuning: EngineTuning }).tuning, values);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  const update = (key: keyof EngineTuning, value: number) => {
    const next = { ...values, [key]: value };
    setValues(next);
    localStorage.setItem(storageKey(avatarId), JSON.stringify(next));
    if (engine && "tuning" in engine) {
      (engine as unknown as { tuning: EngineTuning }).tuning[key] = value;
    }
  };

  const reset = () => {
    localStorage.removeItem(storageKey(avatarId));
    setValues({ ...DEFAULT_TUNING });
    if (engine && "tuning" in engine) {
      Object.assign((engine as unknown as { tuning: EngineTuning }).tuning, DEFAULT_TUNING);
    }
  };

  return (
    <div className="card">
      <button
        className="flex w-full items-center justify-between font-medium"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="inline-flex items-center gap-2">
          <Icon name="sliders" className="h-4 w-4" />
          {t("tuning")}
        </span>
        <span className="text-gray-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-4 flex flex-col gap-3">
          {SLIDERS.filter((s) => !(is3d && s.photoOnly)).map((slider) => (
            <div key={slider.key}>
              <div className="mb-1 flex justify-between text-xs">
                <label htmlFor={`tune-${slider.key}`} className="text-gray-600 dark:text-gray-300">
                  {t(slider.labelKey)}
                </label>
                <span className="tabular-nums text-gray-400">
                  {values[slider.key].toFixed(2)}
                </span>
              </div>
              <input
                id={`tune-${slider.key}`}
                type="range"
                className="w-full accent-brand-600"
                min={slider.min}
                max={slider.max}
                step={slider.step}
                value={values[slider.key]}
                onChange={(e) => update(slider.key, Number(e.target.value))}
              />
            </div>
          ))}
          <button className="btn-secondary self-end px-3 py-1 text-xs" onClick={reset}>
            {t("tuneReset")}
          </button>
        </div>
      )}
    </div>
  );
}
