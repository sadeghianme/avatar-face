import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { api, ApiError } from "../lib/api";
import type { Avatar } from "../lib/types";

/**
 * Opt-in AI mouth keyframes.
 *
 * Deliberately a button rather than something that happens on upload: it
 * spends image-generation quota and takes about a minute. The cost is stated
 * before the click, and turning the feature off later keeps the frames — so
 * switching back on is free.
 */
export function MouthFramesPanel({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = (avatar.viseme_frames ?? 0) > 0;

  const run = async (enable: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const path = `/orgs/${orgId}/avatars/${avatar.id}/viseme-frames`;
      if (enable) await api.post(path, {});
      else await api.delete(path);
      await queryClient.invalidateQueries({ queryKey: ["avatar", orgId, avatar.id] });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-medium">
            <Icon name="mouth" className="h-4 w-4 text-gray-400" />
            {t("mouthFramesTitle")}
          </h3>
          <p className="mt-1 text-[13px] text-gray-500 dark:text-gray-400">
            {active
              ? t("mouthFramesActive", { count: avatar.viseme_frames ?? 0 })
              : t("mouthFramesBody")}
          </p>
        </div>
        <button
          className={active ? "btn-secondary shrink-0" : "btn-primary shrink-0"}
          onClick={() => void run(!active)}
          disabled={busy}
        >
          {busy && <Spinner className="h-4 w-4" />}
          {busy
            ? t("mouthFramesWorking")
            : active
              ? t("mouthFramesOff")
              : t("mouthFramesOn")}
        </button>
      </div>
      {!active && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t("mouthFramesCost")}</p>
      )}
      {error && <p className="field-error mt-2">{error}</p>}
    </div>
  );
}
