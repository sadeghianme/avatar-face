import { DEFAULT_REFERENCE_PROFILE, PROFILE_LIMITS, normalizeProfile, type ReferenceProfile } from "@liveface/embed/mouth";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Spinner } from "@/components/ui/Spinner";
import { api, ApiError } from "@/lib/api";
import type { Avatar, MouthRenderer } from "@/lib/types";

/** Lip projection belongs to the older geometric prototype only. */
const SLIDERS: (keyof ReferenceProfile)[] = ["teethScale", "teethY", "warmth", "jawRange"];
const LABELS: Record<keyof ReferenceProfile, string> = {
  teethScale: "mouthTeethSize", teethY: "mouthTeethPosition", warmth: "mouthWarmth",
  lipProjection: "mouthTeethSize", jawRange: "mouthJaw",
};

/**
 * Which mouth this avatar speaks with, and how it is fitted.
 *
 * Every change here is a DRAFT edit, like framing or voice: the preview
 * updates at once, the Publish bar appears, and visitors see nothing until
 * the owner publishes. Sliders preview live through `onPreview` and are
 * saved when released, so dragging does not write on every tick.
 */
export function MouthPanel({
  avatar,
  orgId,
  onPreview,
}: {
  avatar: Avatar;
  orgId: string;
  onPreview: (renderer: MouthRenderer, profile: ReferenceProfile) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const saved = avatar.mouth ?? null;
  const [renderer, setRenderer] = useState<MouthRenderer>(saved?.renderer ?? "classic");
  const [profile, setProfile] = useState<ReferenceProfile>(() => normalizeProfile(saved?.profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/orgs/${orgId}/avatars/${avatar.id}`;

  // Re-seed when the server's copy changes under us (publish, discard).
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    setRenderer(saved?.renderer ?? "classic");
    setProfile(normalizeProfile(saved?.profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["avatar", orgId, avatar.id] }),
      queryClient.invalidateQueries({ queryKey: ["avatars", orgId] }),
    ]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Settings saves merge the response into the cached avatar instead of
   * refetching. A refetch re-signs every asset URL, and the preview rebuilds
   * its engine when those change — which it must, because re-marking a face
   * rewrites rig.json under an unchanged key. Rebuilding on every slider
   * release would restart the face mid-sentence for a change that touched no
   * asset at all.
   */
  const save = async (nextRenderer: MouthRenderer, nextProfile: ReferenceProfile) => {
    setError(null);
    try {
      const updated = await api.patch<Avatar>(base, {
        mouth: { renderer: nextRenderer, profile: nextProfile },
      });
      queryClient.setQueryData<Avatar>(["avatar", orgId, avatar.id], (old) =>
        old ? { ...old, ...updated } : old
      );
      void queryClient.invalidateQueries({ queryKey: ["avatars", orgId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    }
  };

  const choose = (next: MouthRenderer) => {
    setRenderer(next);
    onPreview(next, profile);
    void save(next, profile);
  };

  const slide = (key: keyof ReferenceProfile, value: number) => {
    const next = { ...profile, [key]: value };
    setProfile(next);
    onPreview(renderer, next);
  };

  const upload = (file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    void run(() => api.postForm(`${base}/mouth-photo`, form));
  };

  const continuous = renderer === "continuous";
  const hasPhoto = Boolean(saved?.has_oral_photo);

  return (
    <section className="card space-y-4" aria-label={t("mouthTitle")}>
      <div>
        <h3 className="font-semibold">{t("mouthTitle")}</h3>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">{t("mouthHint")}</p>
      </div>

      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("mouthTitle")}>
        {(["classic", "continuous"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={renderer === option}
            disabled={busy}
            onClick={() => renderer !== option && choose(option)}
            className={`rounded-xl border px-3 py-2.5 text-start text-sm transition-colors ${
              renderer === option
                ? "border-brand-500 bg-brand-500/10 font-medium"
                : "border-black/10 hover:border-black/25 dark:border-white/10 dark:hover:border-white/25"
            }`}
          >
            {t(option === "classic" ? "mouthClassic" : "mouthContinuous")}
            <span className="mt-0.5 block text-xs font-normal text-gray-500">
              {t(option === "classic" ? "mouthClassicHint" : "mouthContinuousHint")}
            </span>
          </button>
        ))}
      </div>

      {continuous && (
        <>
          <div className="rounded-xl bg-black/[0.03] p-3 dark:bg-white/[0.04]">
            <p className="text-sm font-medium">{t(hasPhoto ? "mouthPhotoActive" : "mouthPhotoTitle")}</p>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">{t("mouthPhotoHint")}</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(event) => {
                  upload(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
                {busy ? <Spinner className="h-4 w-4" /> : null}
                {t(hasPhoto ? "mouthPhotoReplace" : "mouthPhotoAdd")}
              </button>
              {hasPhoto && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run(() => api.delete(`${base}/mouth-photo`))}>
                  {t("mouthPhotoRemove")}
                </button>
              )}
            </div>
          </div>

          {SLIDERS.map((key) => {
            const [min, max, step] = PROFILE_LIMITS[key];
            return (
              <div key={key}>
                <label className="label flex justify-between gap-2" htmlFor={`mouth-${key}`}>
                  <span>{t(LABELS[key])}</span>
                  <span className="font-mono tabular-nums">{profile[key].toFixed(2)}</span>
                </label>
                <input
                  id={`mouth-${key}`}
                  type="range"
                  className="w-full accent-orange-500"
                  min={min}
                  max={max}
                  step={step}
                  value={profile[key]}
                  onChange={(event) => slide(key, Number(event.target.value))}
                  // Saved on release, not per tick: each save is a draft edit.
                  onPointerUp={() => void save(renderer, profile)}
                  onKeyUp={() => void save(renderer, profile)}
                />
              </div>
            );
          })}
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => {
              const reset = { ...DEFAULT_REFERENCE_PROFILE };
              setProfile(reset);
              onPreview(renderer, reset);
              void save(renderer, reset);
            }}
          >
            {t("mouthReset")}
          </button>
        </>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
    </section>
  );
}
