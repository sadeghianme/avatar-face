import { useState } from "react";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
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
import { FINISH_WARNINGS, teethNoteKey, teethView } from "@/features/avatars/teeth";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";
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

const oneOfWarnings = (code: string): code is (typeof FINISH_WARNINGS)[number] =>
  (FINISH_WARNINGS as readonly string[]).includes(code);

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
  const { t } = useT();
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
      // A warning this page has no words for says the server's sentence.
      text: oneOfWarnings(w.code) ? t(`finishWarning_${w.code}`) : w.detail,
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
    <Banner
      as="section"
      aria-labelledby="finish-notice-title"
      tone={attention ? "warning" : "brand"}
      icon={attention ? "alert" : "sparkles"}
      actions={
        <>
          {toMouthPanel && (
            <Button variant="secondary" size="lg" icon="sparkles" onClick={toMouth}>
              {t("finishNoticeToMouth")}
            </Button>
          )}
          <Button variant="secondary" size="lg" onClick={dismiss}>
            {t("finishNoticeDismiss")}
          </Button>
        </>
      }
    >
      {/* The title runs into the facts: one paragraph, a strip not a card. */}
      <p className="min-w-0 text-[13px] leading-snug text-gray-600 dark:text-gray-300">
        <span
          id="finish-notice-title"
          className={cx(
            "font-medium",
            attention ? "text-amber-800 dark:text-amber-300" : "text-gray-900 dark:text-gray-100"
          )}
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
    </Banner>
  );
}
