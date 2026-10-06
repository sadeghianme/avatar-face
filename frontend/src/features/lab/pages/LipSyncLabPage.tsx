import { useState } from "react";

import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FieldError } from "@/components/ui/FieldError";
import { Select } from "@/components/ui/Select";
import { useAvatar, useAvatars } from "@/features/avatars";
import type { ReferenceUpload } from "@/features/lab/api";
import { LipSyncWorkspace } from "@/features/lab/components/LipSyncWorkspace";
import { ReferenceAvatarWorkspace } from "@/features/lab/components/ReferenceAvatarWorkspace";
import { ReferencePhotoUpload } from "@/features/lab/components/ReferencePhotoUpload";
import { REFERENCE_AVATAR } from "@/features/lab/reference-avatar";
import { useT } from "@/i18n";
import type { Avatar } from "@/lib/types";
import { useOrg } from "@/providers/org";

export function LipSyncLabPage({ reference = false }: { reference?: boolean }) {
  const { t } = useT();
  const { current } = useOrg();
  const [selected, setSelected] = useState("");
  const [testPhoto, setTestPhoto] = useState<(ReferenceUpload & { orgId: string }) | null>(null);
  const uploaded: Avatar | null =
    testPhoto && testPhoto.orgId === current?.id
      ? {
          ...REFERENCE_AVATAR,
          id: `preview-${testPhoto.id}`,
          org_id: testPhoto.orgId,
          name: testPhoto.name,
          image_url: testPhoto.image_url,
          rig_url: testPhoto.rig_url,
          quality_note: testPhoto.quality_note,
        }
      : null;
  const avatars = useAvatars(current?.id);
  const saved = (avatars.data ?? []).filter((a) => a.kind === "photo" && a.status === "ready");
  const eligible = reference
    ? [...(uploaded ? [uploaded] : []), { ...REFERENCE_AVATAR, name: t("referenceSample") }, ...saved]
    : saved;
  const activeId = eligible.some((a) => a.id === selected) ? selected : (eligible[0]?.id ?? "");
  const isSample = reference && activeId === REFERENCE_AVATAR.id;
  const isUpload = reference && activeId === uploaded?.id;
  const detail = useAvatar(current?.id, activeId, { enabled: !isSample && !isUpload });
  const active = isSample ? { ...REFERENCE_AVATAR, name: t("referenceSample") } : isUpload ? uploaded : detail.data;
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-brand-600">{t("photofaceHDAlpha")}</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight">{t(reference ? "referenceLab" : "lipSyncLab")}</h2>
          <p className="mt-3 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
            {t(reference ? "referenceSubtitle" : "lipSyncSubtitle")}
          </p>
        </div>
        <Field id="lip-sync-avatar" label={t("photofaceHDChoose")} className="min-w-56">
          <Select value={activeId} onChange={(e) => setSelected(e.target.value)} disabled={!eligible.length}>
            {!eligible.length && <option value="">{t("photofaceHDNoAvatars")}</option>}
            {eligible.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </header>
      {reference && current && (
        <ReferencePhotoUpload
          key={current.id}
          orgId={current.id}
          selectedPhoto={isUpload ? testPhoto : null}
          onUseSample={() => setSelected(REFERENCE_AVATAR.id)}
          onUploaded={(photo) => {
            setTestPhoto({ ...photo, orgId: current.id });
            setSelected(`preview-${photo.id}`);
          }}
        />
      )}
      {isUpload && testPhoto && (
        <p role="status" className="text-xs text-gray-500">
          {t("referenceTemporary", { hours: testPhoto.retention_hours })}
        </p>
      )}
      {!isSample && !isUpload && (avatars.isError || detail.isError) ? (
        <FieldError>{t("error")}</FieldError>
      ) : active && current ? (
        reference ? (
          <ReferenceAvatarWorkspace key={`${current.id}:${active.id}`} avatar={active} orgId={current.id} />
        ) : (
          <LipSyncWorkspace key={`${current.id}:${active.id}`} avatar={active} orgId={current.id} />
        )
      ) : (
        <Card role="status" className="py-20 text-center text-sm text-gray-500">
          {avatars.isLoading || detail.isFetching ? t("loading") : t("photofaceHDEmptyBody")}
        </Card>
      )}
    </div>
  );
}
