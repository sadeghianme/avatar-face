import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/FieldError";
import { Spinner } from "@/components/ui/Spinner";
import { useDiscardDraft, usePublishAvatar } from "@/features/avatars/api";
import { ApiError } from "@/lib/api";
import type { Avatar } from "@/lib/types";

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
  const publish = usePublishAvatar(orgId, avatar.id);
  const discard = useDiscardDraft(orgId, avatar.id);
  const [busy, setBusy] = useState<"publish" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const neverPublished = !avatar.published;
  const dirty = neverPublished || avatar.unpublished === true;

  const run = async (action: "publish" | "discard") => {
    setBusy(action);
    setError(null);
    try {
      await (action === "publish" ? publish : discard).mutateAsync();
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
      footer={error && <FieldError className="mt-2">{error}</FieldError>}
    >
      {neverPublished ? t("publishFirstBody") : dirty ? t("publishDraftBody") : t("publishLiveBody")}
    </Banner>
  );
}
