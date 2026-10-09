import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FieldError } from "@/components/ui/FieldError";
import { FitReasons } from "@/features/avatars/components/mark/FitReasons";
import { MarkFacePreview } from "@/features/avatars/components/mark/MarkFacePreview";
import { MarkCanvas } from "@/features/avatars/components/MarkCanvas";
import { useMarkFace } from "@/features/avatars/hooks/useMarkFace";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import type { Avatar } from "@/lib/types";

/** Where to put the mouth, said for the line being marked. */
function guideKey(faceType: Avatar["face_type"]): MessageKey {
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
 * too. The state and requests are useMarkFace's.
 */
export function MarkFacePanel({ avatar, orgId, onClose }: { avatar: Avatar; orgId: string; onClose: () => void }) {
  const { t } = useT();
  const marking = useMarkFace(avatar, orgId, onClose);
  const { anchors, marks, busy, previewing } = marking;
  if (!anchors || !marks || !avatar.image_url) return null;

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
        <MarkCanvas imageUrl={avatar.image_url} imageSize={anchors.image_size} marks={marks} onChange={marking.move} />
        <MarkFacePreview avatar={avatar} orgId={orgId} imageUrl={avatar.image_url} marking={marking} />
      </div>

      <FitReasons reasons={marking.reasons} />
      {marking.error && <FieldError className="mt-3">{marking.error}</FieldError>}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={marking.test} disabled={busy !== null || previewing}>
          {previewing ? t("loading") : t("test")}
        </Button>
        <Button onClick={marking.save} disabled={busy !== null}>
          {busy === "save" ? t("saving") : t("save")}
        </Button>
        <Button variant="secondary" onClick={marking.redetect} disabled={busy !== null} title={t("redetectHint")}>
          {busy === "redetect" ? t("loading") : t("redetect")}
        </Button>
        <Button variant="secondary" onClick={marking.resetToDetected} disabled={busy !== null}>
          {t("resetDetected")}
        </Button>
      </div>
    </Card>
  );
}
