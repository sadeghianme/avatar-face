import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { api, ApiError } from "@/lib/api";
import type { Avatar } from "@/lib/types";

/**
 * The line between editing and shipping.
 *
 * Everything on this page edits a DRAFT. Embedded sites and share links keep
 * serving the last published snapshot until Publish is pressed, so an owner
 * can crop, re-mark, restyle and listen without a visitor ever seeing a
 * half-finished avatar.
 *
 * Shown in both states on purpose. A bar that only appears when there are
 * changes leaves people wondering whether their last edit went live; one
 * that always says which state you are in answers that without being asked.
 */
export function PublishBar({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"publish" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = avatar.unpublished === true;

  const run = async (action: "publish" | "discard") => {
    setBusy(action);
    setError(null);
    try {
      await api.post(
        `/orgs/${orgId}/avatars/${avatar.id}/${action === "publish" ? "publish" : "discard-draft"}`,
        {}
      );
      await queryClient.invalidateQueries({ queryKey: ["avatar", orgId, avatar.id] });
      await queryClient.invalidateQueries({ queryKey: ["avatars", orgId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={`card mb-6 ${
        dirty ? "border-amber-300/70 dark:border-amber-500/40" : ""
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Icon
            name={dirty ? "clock" : "check"}
            className={`mt-0.5 h-4 w-4 shrink-0 ${
              dirty ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"
            }`}
          />
          <div>
            <p className="text-sm font-medium">
              {dirty ? t("publishDraftTitle") : t("publishLiveTitle")}
            </p>
            <p className="mt-0.5 text-[13px] text-gray-500 dark:text-gray-400">
              {dirty ? t("publishDraftBody") : t("publishLiveBody")}
            </p>
          </div>
        </div>

        {dirty && (
          <div className="flex shrink-0 gap-2">
            <button
              className="btn-secondary"
              onClick={() => void run("discard")}
              disabled={busy !== null}
            >
              {busy === "discard" ? <Spinner className="h-4 w-4" /> : t("publishDiscard")}
            </button>
            <button
              className="btn-primary"
              onClick={() => void run("publish")}
              disabled={busy !== null}
            >
              {busy === "publish" ? <Spinner className="h-4 w-4" /> : t("publish")}
            </button>
          </div>
        )}
      </div>
      {error && <p className="field-error mt-2">{error}</p>}
    </div>
  );
}
