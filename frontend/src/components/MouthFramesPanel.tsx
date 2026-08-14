import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { api, ApiError } from "../lib/api";
import type { Avatar } from "../lib/types";

/**
 * The mouth: free by default, AI only if switched on.
 *
 * Off is the default and must stay the default — the free mouth is a local
 * warp that costs nothing, the AI mouth spends the owner's image quota. So
 * this is a switch showing which one is in use, never an action that runs
 * because a page was opened. The first switch-on generates (stating the
 * cost first); later ones reuse what was already paid for.
 */
export function MouthFramesPanel({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const on = (avatar.viseme_frames ?? 0) > 0;

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = `/orgs/${orgId}/avatars/${avatar.id}/viseme-frames`;
      if (on) await api.delete(path);
      else await api.post(path, {});
      await queryClient.invalidateQueries({ queryKey: ["avatar", orgId, avatar.id] });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 font-medium">
            <Icon name="mouth" className="h-4 w-4 text-gray-400" />
            {t("mouthFramesTitle")}
          </h3>
          <p className="mt-1 text-[13px] text-gray-500 dark:text-gray-400">
            {on ? t("mouthModeAiBody", { count: avatar.viseme_frames ?? 0 }) : t("mouthModeFreeBody")}
          </p>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t("mouthFramesTitle")}
          onClick={() => void toggle()}
          disabled={busy}
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors
            disabled:cursor-not-allowed disabled:opacity-60
            ${on ? "bg-brand-600" : "bg-gray-300 dark:bg-gray-600"}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all
              ${on ? "start-[22px]" : "start-0.5"}`}
          />
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs">
        <span
          className={`rounded-full px-2 py-0.5 font-medium ${
            on
              ? "bg-brand-600/10 text-brand-700 dark:text-brand-400"
              : "bg-gray-500/10 text-gray-600 dark:text-gray-300"
          }`}
        >
          {on ? t("mouthModeAi") : t("mouthModeFree")}
        </span>
        {busy && (
          <span className="flex items-center gap-1.5 text-gray-500">
            <Spinner className="h-3.5 w-3.5" />
            {t("mouthFramesWorking")}
          </span>
        )}
      </div>

      {!on && !busy && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t("mouthFramesCost")}</p>
      )}
      {error && <p className="field-error mt-2">{error}</p>}
    </div>
  );
}
