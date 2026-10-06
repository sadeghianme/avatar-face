import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { api, ApiError } from "@/lib/api";
import type { Avatar } from "@/lib/types";

/**
 * Publish the draft, then show the page what is live now. What the bar's
 * button does, for a panel that prompts it next to the edit that needs it
 * (on a phone the bar is a long scroll away).
 */
export async function publishDraft(queryClient: QueryClient, orgId: string, avatarId: string): Promise<void> {
  await api.post(`/orgs/${orgId}/avatars/${avatarId}/publish`, {});
  await queryClient.invalidateQueries({ queryKey: ["avatar", orgId, avatarId] });
  await queryClient.invalidateQueries({ queryKey: ["avatars", orgId] });
}

/**
 * The line between editing and shipping.
 *
 * Everything on this page edits a DRAFT. Embedded sites and share links keep
 * serving the last published snapshot until Publish is pressed, so an owner
 * can crop, re-mark, restyle and listen without a visitor ever seeing a
 * half-finished avatar.
 *
 * Shown in every state on purpose. A bar that only appears when there are
 * changes leaves people wondering whether their last edit went live; one
 * that always says which state you are in answers that without being asked.
 *
 * A never-published avatar is its own state, not "unpublished changes": a
 * first build the server was not confident about waits here for its owner,
 * and there is no published version to discard back to.
 */
export function PublishBar({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"publish" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const neverPublished = !avatar.published;
  const dirty = neverPublished || avatar.unpublished === true;

  const run = async (action: "publish" | "discard") => {
    setBusy(action);
    setError(null);
    try {
      if (action === "publish") {
        await publishDraft(queryClient, orgId, avatar.id);
      } else {
        await api.post(`/orgs/${orgId}/avatars/${avatar.id}/discard-draft`, {});
        await queryClient.invalidateQueries({ queryKey: ["avatar", orgId, avatar.id] });
        await queryClient.invalidateQueries({ queryKey: ["avatars", orgId] });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(null);
    }
  };

  // One slim strip: the state and its one line on the left, the actions on
  // the right. It sits at the top of the avatar page's settings column,
  // beside the preview, so it never pushes the page down.
  return (
    <Banner
      role="status"
      tone={dirty ? "warning" : "success"}
      icon={dirty ? "clock" : "check"}
      title={neverPublished ? t("publishFirstTitle") : dirty ? t("publishDraftTitle") : t("publishLiveTitle")}
      actions={
        dirty && (
          <>
            {!neverPublished && (
              <Button variant="secondary" size="lg" onClick={() => void run("discard")} disabled={busy !== null}>
                {busy === "discard" ? <Spinner className="h-4 w-4" /> : t("publishDiscard")}
              </Button>
            )}
            <Button size="lg" onClick={() => void run("publish")} disabled={busy !== null}>
              {busy === "publish" ? <Spinner className="h-4 w-4" /> : t("publish")}
            </Button>
          </>
        )
      }
      footer={error && <p className="field-error mt-2">{error}</p>}
    >
      {neverPublished ? t("publishFirstBody") : dirty ? t("publishDraftBody") : t("publishLiveBody")}
    </Banner>
  );
}
