import type { AvatarEngine } from "@liveface/embed";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { previewRigFit, useResetRig, useRigAnchors, useSaveRigFit } from "@/features/avatars/api";
import { AvatarPreview } from "@/features/avatars/components/AvatarPreview";
import { MarkCanvas } from "@/features/avatars/components/MarkCanvas";
import { type FaceMarks, FIT_REASON_LABELS, type FitReason, marksToSend } from "@/features/avatars/face-marks";
import { SpeakPanel } from "@/features/voices";
import { ApiError } from "@/lib/api";
import type { Avatar } from "@/lib/types";

// Once the owner has asked for a preview, it follows their marks: this long
// after the last drag or nudge, so holding an arrow key sends one request.
const LIVE_PREVIEW_DELAY_MS = 450;

/** Where to put the mouth, said for the line being marked. */
function guideKey(faceType: Avatar["face_type"]): string {
  if (faceType === "animal") return "markFaceHintAnimal";
  if (faceType === "cartoon") return "markFaceHintCartoon";
  return "markFaceHint";
}

/**
 * Mark the face by hand.
 *
 * Auto-detection fits a human face, and nothing detects an animal, so every
 * avatar is a guess until its owner has placed the head, the eyes and the
 * mouth. The marks follow the avatar's line — a human mouth by its edges,
 * an animal's or a cartoon's as a line along the lip seam with a chin — and
 * the server says which, in the anchors it opens the panel with.
 *
 * Handles open where the fit wants them, so a good detection means dragging
 * nothing. Nothing is written until Save: Test asks the server for the
 * fitted rig WITHOUT persisting and previews that exact object, and keeps
 * doing so as the marks move. What the server would refuse (a folded face,
 * eyes the wrong way round) is listed under the preview, and Save refuses it
 * too.
 */
export function MarkFacePanel({ avatar, orgId, onClose }: { avatar: Avatar; orgId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [marks, setMarks] = useState<FaceMarks | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // The marks the preview shows; the preview is live once there is one.
  const [previewed, setPreviewed] = useState<FaceMarks | null>(null);
  const [live, setLive] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [reasons, setReasons] = useState<FitReason[]>([]);
  const [busy, setBusy] = useState<"save" | "redetect" | null>(null);
  const [engine, setEngine] = useState<AvatarEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Answers can arrive out of order; only the newest request may land.
  const latest = useRef(0);

  const { data } = useRigAnchors(orgId, avatar);
  const saveFit = useSaveRigFit(orgId, avatar.id);
  const resetRig = useResetRig(orgId, avatar.id);

  useEffect(() => {
    if (data && !marks) setMarks(data.anchors);
  }, [data, marks]);

  // Blob URLs are a real allocation; drop the previous one on every replace
  // and on unmount, or a few previews leak the whole rig each time.
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl]
  );

  const fitFailed = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.code === "fit_invalid" && Array.isArray(err.body.reasons)) {
        setReasons(err.body.reasons as FitReason[]);
      } else {
        setError(err instanceof ApiError ? err.detail : t("error"));
      }
    },
    [t]
  );

  useEffect(() => {
    if (!live || !marks || marks === previewed) return;
    const request = ++latest.current;
    const timer = window.setTimeout(
      async () => {
        setPreviewing(true);
        setError(null);
        try {
          const result = await previewRigFit(orgId, avatar.id, data ? marksToSend(marks, data.anchors) : marks);
          if (request !== latest.current) return;
          const blob = new Blob([JSON.stringify(result.rig)], { type: "application/json" });
          setPreviewUrl(URL.createObjectURL(blob));
          setReasons(result.reasons);
          setPreviewed(marks);
        } catch (err) {
          if (request === latest.current) {
            fitFailed(err);
            setLive(false);
          }
        } finally {
          if (request === latest.current) setPreviewing(false);
        }
      },
      previewed ? LIVE_PREVIEW_DELAY_MS : 0
    );
    return () => window.clearTimeout(timer);
  }, [live, marks, previewed, orgId, avatar.id, data, fitFailed]);

  if (!data || !marks || !avatar.image_url) return null;

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      // A head the owner did not touch goes without its outline diagonals,
      // which the server then keeps as saved (see marksToSend).
      await saveFit.mutateAsync(marksToSend(marks, data.anchors));
      onClose();
    } catch (err) {
      fitFailed(err);
    } finally {
      setBusy(null);
    }
  };

  /** Throw the marking away and re-detect from the original photo. Saving
   * overwrites the rig, so without this a bad marking is unrecoverable. */
  const redetect = async () => {
    setBusy("redetect");
    setError(null);
    try {
      await resetRig.mutateAsync();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(null);
    }
  };

  const reasonText = (reason: FitReason) => {
    const key = FIT_REASON_LABELS[reason.code];
    return key ? t(key, { count: reason.count ?? 0 }) : reason.detail;
  };

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-medium">{t("markFace")}</h3>
        <Button variant="secondary" size="xs" onClick={onClose} aria-label={t("close")}>
          ✕
        </Button>
      </div>
      <p className="mb-1 text-xs text-gray-500">{t(guideKey(avatar.face_type))}</p>
      <p className="mb-3 text-xs text-gray-500">{t("markFaceKeys")}</p>

      <div className="grid gap-4 md:grid-cols-[3fr_2fr]">
        <MarkCanvas
          imageUrl={avatar.image_url}
          imageSize={data.image_size}
          marks={marks}
          onChange={(next) => {
            setMarks(next);
            setReasons([]);
          }}
        />

        <div>
          <p className="mb-2 text-xs font-medium text-gray-500">
            {t("testBeforeSave")}
            {previewing && <span className="ml-2 font-normal">{t("markPreviewUpdating")}</span>}
          </p>
          {previewUrl ? (
            <>
              <AvatarPreview rigUrl={previewUrl} textureUrl={avatar.image_url} size={280} onEngine={setEngine} />
              <div className="mt-3">
                <SpeakPanel engine={engine} orgId={orgId} />
              </div>
            </>
          ) : (
            <div
              className="flex h-[280px] items-center justify-center rounded-xl border border-dashed
              border-gray-300 text-center text-xs text-gray-500 dark:border-line"
            >
              {t("testHint")}
            </div>
          )}
        </div>
      </div>

      {reasons.length > 0 && (
        <div
          className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900
          dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          role="alert"
        >
          <p className="font-medium">{t("fitRefusedTitle")}</p>
          <ul className="mt-1 list-disc pl-5">
            {reasons.map((reason) => (
              <li key={reason.code}>{reasonText(reason)}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="field-error mt-3">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            setLive(true);
            setPreviewed(null);
          }}
          disabled={busy !== null || previewing}
        >
          {previewing ? t("loading") : t("test")}
        </Button>
        <Button onClick={() => void save()} disabled={busy !== null}>
          {busy === "save" ? t("saving") : t("save")}
        </Button>
        <Button variant="secondary" onClick={() => void redetect()} disabled={busy !== null} title={t("redetectHint")}>
          {busy === "redetect" ? t("loading") : t("redetect")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setMarks(data.anchors);
            setReasons([]);
          }}
          disabled={busy !== null}
        >
          {t("resetDetected")}
        </Button>
      </div>
    </Card>
  );
}
