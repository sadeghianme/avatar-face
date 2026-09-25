import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import {
  finishNoticeFor,
  forgetFinishNotice,
  type DraftStore,
  type FinishNotice as Notice,
} from "@/features/avatars/creation";
import {
  factNeedsAttention,
  factText,
  factWantsMore,
  preparedFacts,
  type PreparedFact,
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
 */
export function FinishNotice({ avatar, aiEnabled }: { avatar: Avatar; aiEnabled: boolean }) {
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
    const panel = document.getElementById("mouth-panel");
    panel?.scrollIntoView({ behavior: "smooth", block: "start" });
    panel?.focus({ preventScroll: true });
  };

  return (
    <section
      aria-labelledby="finish-notice-title"
      className={`card mb-6 ${attention ? "border-amber-300/60 dark:border-amber-500/30" : ""}`}
    >
      <h2
        id="finish-notice-title"
        className={`text-sm font-medium ${
          attention ? "text-amber-800 dark:text-amber-300" : "text-gray-900 dark:text-gray-100"
        }`}
      >
        {t(attention ? "finishNoticeTitle" : "finishNoticePreparedTitle")}
      </h2>
      <ul className="mt-2 space-y-1.5 text-[13.5px] text-gray-700 dark:text-gray-200">
        {items.map((item) => (
          <li key={item.key} className="flex items-start gap-2">
            <Icon
              name={item.icon}
              className={`mt-0.5 h-4 w-4 shrink-0 ${
                item.icon === "alert"
                  ? "text-amber-600 dark:text-amber-400"
                  : item.icon === "check"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-brand-600 dark:text-brand-300"
              }`}
            />
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
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
