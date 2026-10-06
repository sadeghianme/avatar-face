import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { FieldError } from "@/components/ui/FieldError";
import { FileInput } from "@/components/ui/FileInput";
import { type ReferenceUpload, uploadReferencePhoto } from "@/features/lab/api";
import { REFERENCE_SCRIPT_ID } from "@/features/lab/reference-avatar";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";

/** A temporary lab upload, using existing signed storage and face rigging.
 * It cannot publish an avatar or send an image to an external AI provider. */
export function ReferencePhotoUpload({
  orgId,
  onUploaded,
  purpose = "portrait",
  selectedPhoto,
  onUseSample,
}: {
  orgId: string;
  onUploaded: (photo: ReferenceUpload) => void;
  purpose?: "portrait" | "mouth";
  selectedPhoto?: ReferenceUpload | null;
  onUseSample?: () => void;
}) {
  const { t } = useT();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview]
  );
  const upload = async (file?: File) => {
    if (!file || inFlight.current) return;
    setError(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError(t("referenceUploadType"));
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError(t("referenceUploadSize"));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setPreview(URL.createObjectURL(file));
    const abort = new AbortController();
    request.current = abort;
    const timeout = window.setTimeout(() => abort.abort(), 90_000);
    try {
      const next = await uploadReferencePhoto(orgId, purpose, file, abort.signal);
      if (alive.current)
        onUploaded({ ...next, name: file.name.replace(/\.[^.]+$/, "").slice(0, 128) || t("referenceYourPhoto") });
    } catch (reason) {
      if (alive.current) {
        setPreview(null);
        setError(
          abort.signal.aborted ? t("referenceUploadTimeout") : reason instanceof Error ? reason.message : t("error")
        );
      }
    } finally {
      clearTimeout(timeout);
      request.current = null;
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const thumbnail = busy ? preview : (selectedPhoto?.image_url ?? (purpose === "mouth" ? preview : null));
  return (
    <section
      className={cx(
        "rounded-xl border border-dashed p-4",
        dragging ? "border-brand-500 bg-brand-50 dark:bg-brand-950" : "border-gray-300 dark:border-gray-700"
      )}
      aria-label={t(purpose === "portrait" ? "referenceUploadTitle" : "referenceMouthUploadTitle")}
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void upload(e.dataTransfer.files[0]);
      }}
    >
      <div className="flex flex-wrap items-center gap-4">
        {thumbnail && (
          <img src={thumbnail} alt={t("referenceUploadPreview")} className="h-20 w-20 rounded-lg object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">
            {t(purpose === "portrait" ? "referenceUploadTitle" : "referenceMouthUploadTitle")}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            {t(purpose === "portrait" ? "referenceUploadHint" : "referenceMouthUploadHint")}
          </p>
        </div>
        <Button disabled={busy} onClick={() => input.current?.click()}>
          {t(
            busy
              ? "referenceUploadBusy"
              : purpose === "portrait"
                ? selectedPhoto
                  ? "referenceChangePhoto"
                  : "referenceUploadButton"
                : "referenceMouthUploadButton"
          )}
        </Button>
      </div>
      <FileInput
        ref={input}
        accept="image/jpeg,image/png,image/webp"
        aria-label={t(purpose === "portrait" ? "referenceUploadButton" : "referenceMouthUploadButton")}
        disabled={busy}
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <p role="status" className="mt-2 text-xs text-gray-500">
        {t(busy ? "referenceUploadProcessing" : "referenceUploadPrivacy")}
      </p>
      {selectedPhoto && !busy && (
        <div className="mt-4 space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700">
          <p role="status" className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
            {t("referencePhotoActive", { name: selectedPhoto.name })}
          </p>
          <p className="text-xs text-gray-500">{t("referencePhotoNext")}</p>
          {selectedPhoto.quality_note && (
            <p className="text-xs text-amber-700 dark:text-amber-300">{selectedPhoto.quality_note}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="#reference-speech" onClick={() => document.getElementById(REFERENCE_SCRIPT_ID)?.focus()}>
              {t("referenceTestPhoto")}
            </ButtonLink>
            {onUseSample && (
              <Button variant="secondary" onClick={onUseSample}>
                {t("referenceUseSample")}
              </Button>
            )}
          </div>
        </div>
      )}
      {error && <FieldError className="mt-2">{error}</FieldError>}
    </section>
  );
}
