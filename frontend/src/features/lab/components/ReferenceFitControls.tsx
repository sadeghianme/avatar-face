import { PROFILE_LIMITS, type ReferenceProfile } from "@liveface/embed/mouth/reference-mouth-model";
import { useTranslation } from "react-i18next";

const LABELS: Record<keyof ReferenceProfile, string> = {
  teethScale: "referenceTeethSize", teethY: "referenceTeethPosition", warmth: "referenceWarmth",
  lipProjection: "referenceProjection", jawRange: "referenceJaw",
};

export function ReferenceFitControls({ profile, update, save, reset, status, photographic = false, continuous = false }: {
  photographic?: boolean;
  continuous?: boolean;
  profile: ReferenceProfile;
  update: (next: ReferenceProfile) => void;
  save: () => void;
  reset: () => void;
  status: "idle" | "saved" | "failed";
}) {
  const { t } = useTranslation();
  return <section className="card space-y-4">
    <div><h3 className="font-semibold">{t("referenceFit")}</h3><p className="mt-1 text-xs leading-relaxed text-gray-500">{t(photographic ? "referencePhotographicFit" : "referenceFitHint")}</p></div>
    {(Object.keys(PROFILE_LIMITS) as (keyof ReferenceProfile)[]).filter(key => !(continuous || photographic) || key !== "lipProjection").map(key => {
      const [min, max, step] = PROFILE_LIMITS[key];
      return <div key={key}>
        <label className="label flex justify-between gap-2" htmlFor={`reference-${key}`}><span>{t(LABELS[key])}</span><span className="font-mono tabular-nums">{profile[key].toFixed(2)}</span></label>
        <input id={`reference-${key}`} type="range" className="w-full accent-orange-500" min={min} max={max} step={step} value={profile[key]} onChange={event => update({ ...profile, [key]: Number(event.target.value) })} />
      </div>;
    })}
    <div className="flex flex-wrap gap-2"><button className="btn-primary" onClick={save}>{t("referenceSave")}</button><button className="btn-secondary" onClick={reset}>{t("referenceReset")}</button></div>
    <p className="text-xs leading-relaxed text-gray-500" role="status">{t(status === "saved" ? "referenceSaved" : status === "failed" ? "referenceSaveFailed" : "referenceLocalOnly")}</p>
  </section>;
}
