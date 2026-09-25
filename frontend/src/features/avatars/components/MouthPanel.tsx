import { DEFAULT_REFERENCE_PROFILE, PROFILE_LIMITS, normalizeProfile, type ReferenceProfile } from "@liveface/embed/mouth";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { publishDraft } from "@/features/avatars/components/PublishBar";
import { useConsent } from "@/features/avatars/hooks/useConsent";
import { mouthErrorKey, teethNoteKey, teethView, type MouthAction } from "@/features/avatars/teeth";
import { api, ApiError } from "@/lib/api";
import type { Avatar, MouthRenderer } from "@/lib/types";

/** The photographic mouth paints human teeth; the server refuses it elsewhere. */
const rendererChoices = (avatar: Avatar): MouthRenderer[] =>
  (avatar.face_type ?? "human") === "human" ? ["classic", "continuous"] : ["classic"];

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
 *
 * The photographic mouth says whose teeth it shows: made by AI from the
 * avatar's picture (what a new person's avatar gets when it is built), the
 * owner's own "ee" photo, or standard ones, with the reason AI teeth could
 * not be made when that is why. "Make my teeth with AI" makes them here, on
 * the member's third-party AI consent (asked once, useConsent.withAi); a
 * new teeth photo, made or uploaded, is followed by a Publish prompt beside
 * it, since the bar that also offers it may be a long scroll away.
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
  const choices = rendererChoices(avatar);
  const savedRenderer: MouthRenderer =
    saved && choices.includes(saved.renderer) ? saved.renderer : "classic";
  const [renderer, setRenderer] = useState<MouthRenderer>(savedRenderer);
  const [profile, setProfile] = useState<ReferenceProfile>(() => normalizeProfile(saved?.profile));
  const [busy, setBusy] = useState(false);
  const [making, setMaking] = useState(false);
  // A teeth photo changed in this visit (made, uploaded): prompt Publish
  // until the draft is live.
  const [changed, setChanged] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refused teeth request is said beside its buttons, not under the
  // sliders: on a phone those are a screen apart.
  const [teethError, setTeethError] = useState<string | null>(null);
  const consent = useConsent(orgId);
  const base = `/orgs/${orgId}/avatars/${avatar.id}`;

  // Re-seed when the server's copy changes under us (publish, discard).
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    setRenderer(savedRenderer);
    setProfile(normalizeProfile(saved?.profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["avatar", orgId, avatar.id] }),
      queryClient.invalidateQueries({ queryKey: ["avatars", orgId] }),
    ]);

  /** A refused teeth request in words: the panel's own for what it knows,
   * the server's sentence otherwise. */
  const refusal = (err: unknown, action: MouthAction | null) => {
    if (!(err instanceof ApiError)) return t("error");
    const key = action ? mouthErrorKey(err.code, action) : null;
    return key ? t(key) : err.detail || t("error");
  };

  /** One teeth request; resolves to its answer, or null when it failed (the
   * error is shown) or nothing was sent ("Not now"). */
  const run = async <T,>(work: () => Promise<T | null>, action: MouthAction | null): Promise<T | null> => {
    setBusy(true);
    setTeethError(null);
    try {
      const result = await work();
      await refresh();
      return result;
    } catch (err) {
      setTeethError(refusal(err, action));
      return null;
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
    void run(() => api.postForm<Avatar>(`${base}/mouth-photo`, form), "upload").then((done) => {
      if (done) setChanged(true);
    });
  };

  /**
   * The person's own teeth, made by AI from this avatar's picture: what a
   * new avatar gets when it is made, for one made before, or whose teeth
   * could not be made then. A draft edit, like the upload; the member's
   * remembered consent is used, or asked for once (useConsent.withAi), and
   * "Not now" sends nothing.
   */
  const makeTeeth = () => {
    void run(
      () =>
        consent.withAi(t("mouthTeethGenerate"), async (consentId) => {
          // Only once the member has agreed: the dialog is not the wait.
          setMaking(true);
          try {
            return await api.post<Avatar>(`${base}/mouth-photo/generate`, { consent_id: consentId });
          } finally {
            setMaking(false);
          }
        }),
      "generate"
    ).then((done) => {
      if (done) setChanged(true);
    });
  };

  const publish = async () => {
    setPublishing(true);
    setTeethError(null);
    try {
      await publishDraft(queryClient, orgId, avatar.id);
      setChanged(false);
    } catch (err) {
      setTeethError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setPublishing(false);
    }
  };

  const continuous = renderer === "continuous";
  const hasPhoto = Boolean(saved?.has_oral_photo);
  const teeth = teethView(saved);
  const aiTeeth = teeth?.kind === "ai";
  const note = teeth?.kind === "generic" ? teeth.note : null;
  const noteKey = note ? teethNoteKey(note.code) : null;
  // Offered while the organization allows third-party AI; the server
  // refuses otherwise anyway (and says so). Never over the owner's own
  // photo: they chose it, and removing it first is one press.
  const canMakeTeeth = consent.aiEnabled && renderer === "continuous" && (!hasPhoto || aiTeeth);
  // Until the draft with the new teeth is live.
  const promptPublish = changed && (avatar.unpublished === true || !avatar.published);
  // One region, always mounted, says what happens to the teeth: a region
  // mounted with its text is not reliably read out.
  const spoken = making ? t("mouthTeethGenerating") : promptPublish ? t("mouthTeethMade") : "";

  return (
    <section id="mouth-panel" tabIndex={-1} className="card space-y-4 outline-none" aria-label={t("mouthTitle")}>
      <div>
        <h3 className="font-semibold">{t("mouthTitle")}</h3>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">{t("mouthHint")}</p>
      </div>

      <div
        className={`grid gap-2 ${choices.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}
        role="radiogroup"
        aria-label={t("mouthTitle")}
      >
        {choices.map((option) => (
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

      {choices.length === 1 && (
        <p className="text-xs leading-relaxed text-gray-500">{t("mouthHumanOnly")}</p>
      )}

      {continuous && (
        <>
          <div className="rounded-xl bg-black/[0.03] p-3 dark:bg-white/[0.04]" id="mouth-teeth">
            {teeth && (
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {t("mouthTeethInUse")}
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                    teeth.kind === "generic"
                      ? "bg-gray-200 text-gray-700 dark:bg-white/10 dark:text-gray-200"
                      : "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
                  }`}
                >
                  {teeth.kind === "ai" && <Icon name="sparkles" className="h-3.5 w-3.5" />}
                  {t(`mouthTeethKind_${teeth.kind}`)}
                </span>
              </p>
            )}
            <p className="mt-1 text-xs leading-relaxed text-gray-500">
              {t(aiTeeth ? "mouthTeethAiHint" : hasPhoto ? "mouthPhotoActive" : "mouthPhotoHint")}
            </p>
            {note && (
              <p className="mt-1.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                {noteKey ? t(noteKey) : `${t("mouthTeethGeneric")} ${note.detail}`}
              </p>
            )}
            {canMakeTeeth && (
              <p id="mouth-teeth-generate-hint" className="mt-1.5 text-xs leading-relaxed text-gray-500">
                {t("mouthTeethGenerateHint")}
              </p>
            )}
            {making && (
              <p className="mt-1.5 flex items-center gap-2 text-xs text-gray-500" aria-hidden="true">
                <Spinner className="h-3.5 w-3.5" />
                {t("mouthTeethGenerating")}
              </p>
            )}
            <div className="mt-2.5 flex flex-wrap gap-2">
              {canMakeTeeth && (
                <button
                  type="button"
                  className="btn-secondary min-h-11"
                  disabled={busy}
                  onClick={makeTeeth}
                  aria-describedby="mouth-teeth-generate-hint"
                >
                  {making ? <Spinner className="h-4 w-4" /> : <Icon name="sparkles" className="h-4 w-4" />}
                  {t(aiTeeth ? "mouthTeethRegenerate" : "mouthTeethGenerate")}
                </button>
              )}
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
              <button type="button" className="btn-secondary min-h-11" disabled={busy} onClick={() => fileRef.current?.click()}>
                {busy && !making ? <Spinner className="h-4 w-4" /> : null}
                {t(hasPhoto && !aiTeeth ? "mouthPhotoReplace" : "mouthPhotoAdd")}
              </button>
              {hasPhoto && (
                <button
                  type="button"
                  className="btn-secondary min-h-11"
                  disabled={busy}
                  onClick={() => void run(() => api.delete(`${base}/mouth-photo`), null)}
                >
                  {t("mouthPhotoRemove")}
                </button>
              )}
            </div>
            {teethError && (
              <p className="field-error mt-2.5 text-xs leading-relaxed" role="alert">
                {teethError}
              </p>
            )}
            {promptPublish && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/70 p-2.5 dark:border-amber-500/40">
                <p className="min-w-0 flex-1 text-xs leading-relaxed text-gray-700 dark:text-gray-200">
                  {t("mouthTeethMade")}
                </p>
                <button type="button" className="btn-primary min-h-11" disabled={publishing || busy} onClick={() => void publish()}>
                  {publishing ? <Spinner className="h-4 w-4" /> : null}
                  {t("publish")}
                </button>
              </div>
            )}
            <p className="sr-only" role="status" aria-live="polite">
              {spoken}
            </p>
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
      {consent.dialog}
    </section>
  );
}
