import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ButtonLink } from "@/components/ui/ButtonLink";
import { Card } from "@/components/ui/Card";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { FieldError } from "@/components/ui/FieldError";
import { Icon } from "@/components/ui/Icon";
import { useDeleteCreation, useDrafts } from "@/features/avatars/api";
import { type Creation, currentStep, errorText, isJobActive, jobFailure, stepById } from "@/features/avatars/creation";
import { LINES } from "@/features/avatars/lines";
import { ApiError } from "@/lib/api";

/**
 * "Continue your avatar": the org's unfinished creations, newest first,
 * each with Resume (back into the wizard where it was left) and Delete.
 * Nothing shows when there are none. Drafts expire after a week idle, so
 * this is a short list by construction (the server caps it at ten).
 */
export function DraftCreations({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const { data: drafts } = useDrafts(orgId);

  if (!drafts?.length) return null;
  return (
    <section className="mt-8" aria-labelledby="drafts-heading">
      <h2 id="drafts-heading" className="text-lg font-semibold tracking-[-0.02em]">
        {t("createContinueTitle")}
      </h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("createContinueHint")}</p>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {drafts.map((draft) => (
          <DraftCard key={draft.id} draft={draft} orgId={orgId} />
        ))}
      </ul>
    </section>
  );
}

function DraftCard({ draft, orgId }: { draft: Creation; orgId: string }) {
  const { t, i18n } = useTranslation();
  const deleteCreation = useDeleteCreation(orgId);
  const [attempt, setAttempt] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const image = currentStep(draft) ?? stepById(draft, "original");
  const line = draft.face_type ? t(LINES[draft.face_type].label) : t("createLineUnknown");
  const when = new Intl.DateTimeFormat(i18n.language, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(draft.updated_at));
  const state = isJobActive(draft.job)
    ? t("createDraftWorking")
    : jobFailure(draft.job)
      ? t("createDraftNeedsAttention")
      : null;

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteCreation.mutateAsync(draft.id);
    } catch (err) {
      setError(err instanceof ApiError ? errorText(t, err.code, err.detail) : t("error"));
      setDeleting(false);
      setAttempt((n) => n + 1);
    }
  };

  return (
    <Card as="li" className="flex gap-3 p-3">
      <span className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-xl bg-gray-100 dark:bg-white/[0.06]">
        {image ? (
          <img src={image.url} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <Icon name="image" className="h-6 w-6 text-gray-400" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{line}</p>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{t("createDraftUpdated", { when })}</p>
        {state && <p className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">{state}</p>}
        {error && <FieldError>{error}</FieldError>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ButtonLink
            to={`/avatars/new/${draft.id}`}
            size="sm"
            aria-label={t("createDraftResumeNamed", { line, when })}
          >
            {t("createDraftResume")}
          </ButtonLink>
          {/* Remounted after a failed delete (attempt): the question closes. */}
          <ConfirmButton
            key={attempt}
            quiet
            size="sm"
            confirmSize="sm"
            icon="trash"
            iconClassName="h-3.5 w-3.5"
            label={t("delete")}
            triggerLabel={t("createDraftDeleteNamed", { line, when })}
            question={t("createDraftDeleteConfirm")}
            confirmLabel={t("delete")}
            cancelLabel={t("cancel")}
            busy={deleting}
            onConfirm={() => void remove()}
          />
        </div>
      </div>
    </Card>
  );
}
