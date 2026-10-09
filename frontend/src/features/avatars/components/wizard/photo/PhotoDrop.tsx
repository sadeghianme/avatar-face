import { useId, useRef } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DropZone } from "@/components/ui/DropZone";
import { FieldError } from "@/components/ui/FieldError";
import { FileInput } from "@/components/ui/FileInput";
import { IconButton } from "@/components/ui/IconButton";
import { Label } from "@/components/ui/Label";
import { ACCEPTED_TYPES } from "@/features/avatars/creation";
import type { AvatarModel } from "@/features/avatars/wizard";
import { useT } from "@/i18n";

/** The photo: a place to drop or pick one (and why a file was refused),
 *  then the one chosen, with Change and Remove. */
export function PhotoDrop({
  model,
  file,
  preview,
  error,
  busy,
  onChoose,
  onClear,
}: {
  model: AvatarModel;
  file: File | null;
  preview: string | null;
  error: string | null;
  busy: boolean;
  onChoose: (file: File | undefined) => void;
  onClear: () => void;
}) {
  const { t } = useT();
  const input = useRef<HTMLInputElement>(null);
  const ids = useId();

  if (file && preview) {
    return (
      <div>
        <Label as="p">{t("wzDropLabel")}</Label>
        <Card className="flex items-center gap-4 p-3 shadow-none dark:bg-raised">
          <img src={preview} alt="" className="h-20 w-20 shrink-0 rounded-xl object-cover sm:h-24 sm:w-24" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{file.name}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{(file.size / (1024 * 1024)).toFixed(1)} MB</p>
            <Button
              variant="link"
              className="mt-2 text-start text-sm"
              onClick={() => input.current?.click()}
              disabled={busy}
            >
              {t("wzChangePhoto")}
            </Button>
          </div>
          <IconButton
            variant="plain"
            label={t("wzRemovePhoto")}
            tooltip
            icon="close"
            iconClassName="h-5 w-5"
            className="h-11 w-11 rounded-full hover:bg-gray-100 dark:hover:bg-white/[0.06]"
            onClick={onClear}
            disabled={busy}
          />
          <FileInput
            ref={input}
            srOnly
            tabIndex={-1}
            aria-hidden="true"
            accept={ACCEPTED_TYPES.join(",")}
            onChange={(e) => {
              onChoose(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <Label as="p" id={`${ids}-label`}>
        {t("wzDropLabel")}
      </Label>
      <DropZone
        labelledBy={`${ids}-label`}
        title={t("wzDrop")}
        hint={t(`wzDropHint_${model}`)}
        accept={ACCEPTED_TYPES.join(",")}
        disabled={busy}
        onFile={onChoose}
      />
      {error && <FieldError className="text-sm">{error}</FieldError>}
    </div>
  );
}
