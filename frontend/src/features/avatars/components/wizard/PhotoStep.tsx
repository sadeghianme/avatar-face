import { useId } from "react";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { BackButton, PhoneNote, StepFooter } from "@/features/avatars/components/wizard/Footer";
import { Agreements } from "@/features/avatars/components/wizard/photo/Agreements";
import { DescribeField } from "@/features/avatars/components/wizard/photo/DescribeField";
import { LookChoice } from "@/features/avatars/components/wizard/photo/LookChoice";
import { PhotoDrop } from "@/features/avatars/components/wizard/photo/PhotoDrop";
import { SourceTabs } from "@/features/avatars/components/wizard/photo/SourceTabs";
import type { Creation } from "@/features/avatars/creation";
import type { ConsentApi } from "@/features/avatars/hooks/useConsent";
import { usePhotoStep } from "@/features/avatars/hooks/usePhotoStep";
import type { AvatarModel, Choices } from "@/features/avatars/wizard";
import { useT } from "@/i18n";

/**
 * Step 2: the face. "Generate with AI" (one description, a few example
 * chips) or "Upload a photo", then the look (Realistic, Animation,
 * Cartoon), each shown as a small picture. The agreement to send the
 * photo or the description to the AI, and for a person the statement
 * about the face, are asked here, on this screen, never later as a
 * pop-up; the button says what it is waiting for.
 *
 * "Create my avatar" records the AI agreement (unless the member already
 * agreed to the words in force), sends the photo or the description, and
 * records the statement for the creation that came back, so publishing
 * asks nothing again (usePhotoStep). A realistic upload may go without
 * the AI: its photo is then used as it is, cut out.
 */
export function PhotoStep({
  orgId,
  model,
  consent,
  initial,
  onBack,
  onCreated,
}: {
  orgId: string;
  model: AvatarModel;
  consent: ConsentApi;
  /** Coming Back from step 3: the choices made then. */
  initial: Choices | null;
  onBack: () => void;
  onCreated: (creation: Creation) => void;
}) {
  const { t } = useT();
  const ids = useId();
  const step = usePhotoStep({ orgId, model, consent, initial, onCreated });
  const { form, busy, blocker, progress } = step;

  return (
    <div className="space-y-7">
      <div className="grid gap-7 lg:grid-cols-2 lg:gap-12 xl:gap-16">
        <div className="space-y-7">
          <SourceTabs step={step} />
          {form.source === "generate" ? (
            <DescribeField model={model} description={form.description} onChange={step.describe} busy={busy} />
          ) : (
            <PhotoDrop
              model={model}
              file={form.file}
              preview={form.preview}
              error={form.fileError}
              busy={busy}
              onChoose={step.pick}
              onClear={step.clearFile}
            />
          )}
        </div>

        <div className="space-y-7">
          <LookChoice model={model} step={step} />
          <Agreements step={step} reagree={consent.aiReagree} />
        </div>
      </div>

      {step.error && (
        <Banner appearance="soft" tone="danger" role="alert">
          {step.error}
        </Banner>
      )}

      {blocker && !busy && <PhoneNote id={`${ids}-hold`}>{t(blocker)}</PhoneNote>}

      <StepFooter back={<BackButton onClick={onBack} disabled={busy} />} note={blocker && !busy ? t(blocker) : null}>
        <Button
          size="xl"
          className="shadow-sm shadow-brand-600/20 sm:px-6"
          icon={<Icon name="sparkles" className="h-4 w-4" strokeWidth={1.9} />}
          loading={busy}
          onClick={step.create}
          disabled={Boolean(blocker)}
          aria-describedby={blocker ? `${ids}-hold` : undefined}
        >
          {busy
            ? progress !== null && progress < 1
              ? t("wzUploading", { percent: Math.round(progress * 100) })
              : t("wzStarting")
            : t("wzCreate")}
        </Button>
      </StepFooter>
    </div>
  );
}
