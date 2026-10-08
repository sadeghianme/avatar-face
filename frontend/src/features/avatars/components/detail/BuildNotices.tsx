import { Button } from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Card } from "@/components/ui/Card";
import { FieldError } from "@/components/ui/FieldError";
import { Spinner } from "@/components/ui/Spinner";
import { PrepProgress } from "@/features/avatars/components/PrepProgress";
import { useT } from "@/i18n";
import type { Avatar } from "@/lib/types";

/**
 * Where the avatar's build is, when it is not simply ready: failed (why,
 * and Retry, and why a retry was refused), being built by the wizard's
 * step 5 (followed there, where its stages are, not here, where there is
 * nothing of it yet to retry), or pending and processing (PrepProgress).
 */
export function BuildNotices({
  avatar,
  onRetry,
  retryError,
}: {
  avatar: Avatar;
  onRetry: () => void;
  retryError: string | null;
}) {
  const { t } = useT();
  const preparing = avatar.preparing_creation_id ?? null;
  return (
    <>
      {avatar.status === "failed" && (
        <Card tone="danger" className="mb-4">
          <FieldError live={false}>{avatar.error}</FieldError>
          <Button variant="secondary" size="lg" className="mt-3" onClick={onRetry}>
            {t("retry")}
          </Button>
          {retryError && <FieldError className="mt-2 text-sm">{retryError}</FieldError>}
        </Card>
      )}

      {preparing && (
        <Card as="section" className="mb-4" aria-labelledby="preparing-title">
          <h2 id="preparing-title" className="flex items-center gap-2 font-semibold">
            <Spinner className="h-4 w-4 shrink-0 text-brand-600" />
            {t("avatarPreparingTitle")}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{t("avatarPreparingHint")}</p>
          <ButtonLink variant="secondary" size="lg" className="mt-3" to={`/avatars/new/${preparing}`}>
            {t("avatarPreparingFollow")}
          </ButtonLink>
        </Card>
      )}

      {!preparing && (avatar.status === "pending" || avatar.status === "processing") && (
        <div className="mb-4">
          <PrepProgress avatar={avatar} onRetry={onRetry} error={retryError} />
        </div>
      )}
    </>
  );
}
