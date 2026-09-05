import type { CuePlayer, SpeechPlayer } from "@liveface/embed";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { AvatarPreview } from "@/features/avatars";
import { PhotoFaceHDPreview } from "@/features/lab/components/PhotoFaceHDPreview";
import { SpeakPanel } from "@/features/voices";
import { api } from "@/lib/api";
import { useOrg } from "@/providers/org";
import type { Avatar } from "@/lib/types";

type HDEngine = SpeechPlayer & CuePlayer & { destroy(): void };

/**
 * One Speak press drives BOTH renderers, or the comparison is worthless:
 * judging depth means seeing the same utterance at the same instant, not
 * remembering one run while watching another. The HD engine owns the audio
 * (two players would echo); the stable engine mirrors the cue track.
 */
function fanout(primary: HDEngine, mirror: { playCues(cues: unknown[]): void; syncCueTime(ms: number): void; stopSpeech(): void }): HDEngine {
  return {
    playAudio: (audio, mime, cues, onEnd) => {
      mirror.playCues(cues as unknown[]);
      primary.playAudio(audio, mime, cues, onEnd);
    },
    playCues: (cues) => {
      mirror.playCues(cues as unknown[]);
      primary.playCues(cues);
    },
    syncCueTime: (ms) => {
      mirror.syncCueTime(ms);
      primary.syncCueTime(ms);
    },
    stopSpeech: () => {
      mirror.stopSpeech();
      primary.stopSpeech();
    },
    destroy: () => primary.destroy(),
  } as HDEngine;
}

export function PhotofaceHDPage() {
  const { t } = useTranslation();
  const { current } = useOrg();
  const [selectedId, setSelectedId] = useState("");
  const [hdEngine, setHdEngine] = useState<HDEngine | null>(null);
  const [stableEngine, setStableEngine] = useState<{ playCues(cues: unknown[]): void; syncCueTime(ms: number): void; stopSpeech(): void } | null>(null);
  const handleEngine = useCallback((next: HDEngine | null) => setHdEngine(next), []);
  // Speak drives both when both exist; the HD engine alone until then.
  const engine = hdEngine && stableEngine ? fanout(hdEngine, stableEngine) : hdEngine;

  const { data: avatars = [], isLoading } = useQuery({
    queryKey: ["avatars", current?.id],
    queryFn: () => api.get<Avatar[]>(`/orgs/${current!.id}/avatars`),
    enabled: Boolean(current),
  });
  const eligible = avatars.filter(
    (avatar) => avatar.kind === "photo" && avatar.status === "ready"
  );
  const activeId = eligible.some((avatar) => avatar.id === selectedId)
    ? selectedId
    : eligible[0]?.id ?? "";

  const { data: avatar, isFetching } = useQuery({
    queryKey: ["avatar", current?.id, activeId],
    queryFn: () => api.get<Avatar>(`/orgs/${current!.id}/avatars/${activeId}`),
    enabled: Boolean(current && activeId),
    staleTime: 60_000,
  });

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[32px] font-semibold tracking-[-0.03em] sm:text-[38px]">
              {t("photofaceHD")}
            </h1>
            <span className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300">
              {t("photofaceHDAlpha")}
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-gray-500 dark:text-gray-400">
            {t("photofaceHDSubtitle")}
          </p>
        </div>
      </div>

      <div className="mt-8 grid items-start gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,0.7fr)]">
        <section className="card p-3 sm:p-4" aria-label={t("photofaceHDPreview")}>
          {avatar?.rig_url && avatar.image_url ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <figure>
                <figcaption className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
                  {t("photofaceHDStableLabel")}
                </figcaption>
                <AvatarPreview
                  rigUrl={avatar.rig_url}
                  textureUrl={avatar.image_url ?? avatar.thumbnail_url ?? ""}
                  layerUrls={avatar.layer_urls}
                  fullPhoto={avatar.framing === "full"}
                  onEngine={(instance) => setStableEngine(instance)}
                />
              </figure>
              <figure>
                <figcaption className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
                  {t("photofaceHDLabLabel")}
                </figcaption>
                <PhotoFaceHDPreview avatar={avatar} orgId={current!.id} onEngine={handleEngine} />
              </figure>
            </div>
          ) : (
            <div className="grid aspect-square place-items-center rounded-2xl bg-black/[0.025] px-8 text-center dark:bg-white/[0.035]">
              <div>
                <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand-500/10 text-brand-600 dark:text-brand-300">
                  <Icon name="faces" className="h-6 w-6" />
                </span>
                <h2 className="mt-4 text-lg font-medium">{t("photofaceHDEmptyTitle")}</h2>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                  {isLoading || isFetching ? t("loading") : t("photofaceHDEmptyBody")}
                </p>
              </div>
            </div>
          )}
        </section>

        <aside className="space-y-5">
          <div className="card">
            <label className="label" htmlFor="photoface-avatar">
              {t("photofaceHDChoose")}
            </label>
            <select
              id="photoface-avatar"
              className="input"
              value={activeId}
              disabled={!eligible.length}
              onChange={(event) => {
                setHdEngine(null);
                setStableEngine(null);
                setSelectedId(event.target.value);
              }}
            >
              {!eligible.length ? <option value="">{t("photofaceHDNoAvatars")}</option> : null}
              {eligible.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs leading-relaxed text-gray-400">
              {t("photofaceHDChooseHint")}
            </p>
          </div>

          {current ? <SpeakPanel engine={engine} orgId={current.id} /> : null}

          <div className="card">
            <h2 className="text-sm font-semibold">{t("photofaceHDInside")}</h2>
            <ul className="mt-4 space-y-3 text-[13px] text-gray-600 dark:text-gray-300">
              {["photofaceHDDepth", "photofaceHDLayers", "photofaceHDReuse"].map((key) => (
                <li key={key} className="flex items-start gap-2.5">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                    <Icon name="check" className="h-3 w-3" strokeWidth={2} />
                  </span>
                  <span>{t(key)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 border-t border-black/[0.07] pt-4 text-xs leading-relaxed text-gray-400 dark:border-white/[0.07]">
              {t("photofaceHDIsolation")}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
