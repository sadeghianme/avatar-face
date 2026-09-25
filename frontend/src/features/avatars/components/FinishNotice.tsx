import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import {
  finishNoticeFor,
  forgetFinishNotice,
  type DraftStore,
  type FinishNotice as Notice,
} from "@/features/avatars/creation";
import { teethNoteKey, teethView } from "@/features/avatars/teeth";
import type { Avatar } from "@/lib/types";

function tabStore(): DraftStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * What the owner should know about an avatar the wizard just built, on its
 * page: the finish answer's mouth warnings (an open mouth, teeth painted on
 * parted lips), and why its teeth are standard when AI teeth could not be
 * made, with the way to the Mouth panel, where they can be made again.
 *
 * Shown to the tab that finished it (creation.rememberFinishNotice), until
 * dismissed; the teeth note itself stays in the Mouth panel for good.
 */
export function FinishNotice({ avatar }: { avatar: Avatar }) {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<Notice | null>(() => finishNoticeFor(tabStore(), avatar.id));
  if (!notice) return null;

  const teeth = teethView(avatar.mouth ?? null);
  const note = teeth?.kind === "generic" ? teeth.note : null;
  const noteKey = note ? teethNoteKey(note.code) : null;
  const items = [
    ...notice.warnings.map((w) => ({
      key: w.code,
      text: t(`finishWarning_${w.code}`, { defaultValue: w.detail }),
    })),
    ...(note ? [{ key: "teeth", text: noteKey ? t(noteKey) : `${t("mouthTeethGeneric")} ${note.detail}` }] : []),
  ];
  if (items.length === 0) return null;

  const dismiss = () => {
    forgetFinishNotice(tabStore(), avatar.id);
    setNotice(null);
  };
  const toMouth = () => {
    const panel = document.getElementById("mouth-panel");
    panel?.scrollIntoView({ behavior: "smooth", block: "start" });
    panel?.focus({ preventScroll: true });
  };

  return (
    <section
      aria-labelledby="finish-notice-title"
      className="card mb-6 border-amber-300/60 dark:border-amber-500/30"
    >
      <h2 id="finish-notice-title" className="text-sm font-medium text-amber-800 dark:text-amber-300">
        {t("finishNoticeTitle")}
      </h2>
      <ul className="mt-1.5 list-disc space-y-1 ps-5 text-[13.5px] text-gray-700 dark:text-gray-200">
        {items.map((item) => (
          <li key={item.key}>{item.text}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {note && avatar.mouth?.renderer === "continuous" && (
          <button type="button" className="btn-secondary min-h-11" onClick={toMouth}>
            <Icon name="sparkles" className="h-4 w-4" />
            {t("finishNoticeToMouth")}
          </button>
        )}
        <button type="button" className="btn-secondary min-h-11" onClick={dismiss}>
          {t("finishNoticeDismiss")}
        </button>
      </div>
    </section>
  );
}
