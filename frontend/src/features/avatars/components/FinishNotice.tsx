import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import {
  type DraftStore,
  type FinishNotice as Notice,
  finishNoticeFor,
  forgetFinishNotice,
} from "@/features/avatars/creation";
import {
  factNeedsAttention,
  factText,
  factWantsMore,
  type PreparedFact,
  preparedFacts,
} from "@/features/avatars/mouth-kit";
import { teethNoteKey, teethView } from "@/features/avatars/teeth";
import type { Avatar } from "@/lib/types";

function tabStore(): DraftStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const factKey = (fact: PreparedFact) => (fact.kind === "both_standard" ? "mouth" : fact.kind);

/**
 * What the owner should know about an avatar the wizard just built, on its
 * page: what step 5 gave a person's mouth (their own mouth shapes, how many
 * of the six the AI made from the photo and that the rest are standard;
 * their own teeth, or standard ones and why), and the finish answer's
 * mouth warnings (an open mouth, teeth painted on parted lips). A summary
 * when all went well, a warning when something is standard or wrong, with
 * the way to the Mouth panel, where the shapes and teeth can be made again.
 *
 * Shown to the tab that finished it (creation.rememberFinishNotice), until
 * dismissed; the Mouth panel keeps saying where the mouth comes from.
 *
 * One strip: the title, the facts after it, the two buttons; never a card
 * that pushes the page down.
 */
export function FinishNotice({
  avatar,
  aiEnabled,
  onToMouth,
}: {
  avatar: Avatar;
  aiEnabled: boolean;
  /** Opens the Mouth panel where the page keeps it folded, before this
   *  scrolls to it. */
  onToMouth?: () => void;
}) {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<Notice | null>(() => finishNoticeFor(tabStore(), avatar.id));
  if (!notice) return null;

  const mouth = avatar.mouth ?? null;
  const facts = preparedFacts(mouth, teethView(mouth));
  const items = [
    ...facts.map((fact) => ({
      key: factKey(fact),
      text: factText(t, fact, teethNoteKey),
      icon: factNeedsAttention(fact)
        ? ("alert" as const)
        : fact.kind === "teeth" && fact.view.kind === "upload"
          ? ("check" as const)
          : ("sparkles" as const),
    })),
    ...notice.warnings.map((w) => ({
      key: w.code,
      text: t(`finishWarning_${w.code}`, { defaultValue: w.detail }),
      icon: "alert" as const,
    })),
  ];
  if (items.length === 0) return null;

  const attention = notice.warnings.length > 0 || facts.some(factNeedsAttention);
  // Where the Mouth panel's one AI action can make more of the mouth: it
  // is offered while the organization allows third-party AI.
  const toMouthPanel = aiEnabled && mouth?.renderer === "continuous" && facts.some(factWantsMore);

  const dismiss = () => {
    forgetFinishNotice(tabStore(), avatar.id);
    setNotice(null);
  };
  const toMouth = () => {
    onToMouth?.();
    // After the panel has unfolded, where it is folded.
    window.requestAnimationFrame(() => {
      const panel = document.getElementById("mouth-panel");
      panel?.scrollIntoView({ behavior: "smooth", block: "start" });
      panel?.focus({ preventScroll: true });
    });
  };

  return (
    <section
      aria-labelledby="finish-notice-title"
      className={`card flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${
        attention ? "border-amber-300/60 dark:border-amber-500/30" : ""
      }`}
    >
      <div className="flex min-w-0 flex-1 basis-56 items-start gap-2.5">
        <Icon
          name={attention ? "alert" : "sparkles"}
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            attention ? "text-amber-600 dark:text-amber-400" : "text-brand-600 dark:text-brand-300"
          }`}
        />
        <p className="min-w-0 text-[13px] leading-snug text-gray-600 dark:text-gray-300">
          <span
            id="finish-notice-title"
            className={`font-medium ${
              attention ? "text-amber-800 dark:text-amber-300" : "text-gray-900 dark:text-gray-100"
            }`}
          >
            {t(attention ? "finishNoticeTitle" : "finishNoticePreparedTitle")}
          </span>
          {items.map((item) => (
            <span key={item.key}>
              <span aria-hidden="true"> · </span>
              {item.text}
            </span>
          ))}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {toMouthPanel && (
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
