import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ButtonLink } from "@/components/ui/ButtonLink";
import { CopyButton } from "@/components/ui/CopyButton";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useAvatarSharing } from "@/features/avatars/api";
import { ApiError } from "@/lib/api";
import type { Avatar } from "@/lib/types";

/**
 * Publish this avatar as a page anyone with the link can talk to: the
 * avatar page's Public link section.
 *
 * Off until asked for, and the copy says plainly what "on" means — a link
 * with no password on it spends the owner's speech quota, so nobody should
 * discover that after the fact.
 */
export function SharePanel({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  const { t } = useTranslation();
  const sharing = useAvatarSharing(orgId, avatar.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = avatar.share_token ?? null;
  const url = token ? `${window.location.origin}/s/${token}` : "";

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await sharing.mutateAsync(!token);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 text-[13px] text-gray-500 max-lg:text-sm dark:text-gray-400">
          {token ? t("shareOnBody") : t("shareOffBody")}
        </p>
        <Switch
          size="sm"
          checked={Boolean(token)}
          aria-label={t("shareTitle")}
          onChange={() => void toggle()}
          disabled={busy || avatar.status !== "ready"}
        />
      </div>

      {token && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Input
            readOnly
            value={url}
            onFocus={(e) => e.target.select()}
            aria-label={t("shareTitle")}
            className="min-h-11 min-w-0 flex-1 basis-40 text-xs"
          />
          <CopyButton text={url} label={t("copy")} copiedLabel={t("copied")} size="lg" className="shrink-0" />
          <ButtonLink variant="secondary" size="lg" className="shrink-0" href={url} target="_blank" rel="noreferrer">
            {t("shareOpen")}
          </ButtonLink>
        </div>
      )}
      {error && <p className="field-error mt-2">{error}</p>}
    </div>
  );
}
