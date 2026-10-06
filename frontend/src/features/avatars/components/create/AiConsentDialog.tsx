import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { CONSENT_TEXT_VERSIONS, providerLabel } from "@/features/avatars/consent";

/**
 * The third-party AI statement: what is sent, to whom, what is kept, and
 * that it is optional. One wording, shown two ways: inline in the AI adjust
 * step (a checkbox beside "Fix it with AI"), and as a dialog before the
 * other AI calls (finding an animal's points, generating from a photo,
 * making a person's mouth shapes and teeth in the Mouth panel). It also
 * covers what is sent without a further press: the wizard's lip touch-up,
 * and a person's teeth and mouth shapes made at step 5.
 *
 * The words are versioned (consent.CONSENT_TEXT_VERSIONS.third_party_ai):
 * changing what they say means bumping that version here and on the
 * server, so earlier agreements stop counting and everyone is asked again.
 * The version is shown, since it is what the record will name.
 */
export function AiConsentText({ providers, id }: { providers: readonly string[]; id?: string }) {
  const { t } = useTranslation();
  const named = providers.map(providerLabel).join(", ");
  return (
    <div id={id} className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
      <p>{t("aiConsentSent", { providers: named })}</p>
      <p>{t("aiConsentKept")}</p>
      <p>{t("aiConsentRights")}</p>
      <p>{t("aiConsentOptional")}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t("aiConsentRecorded", { version: CONSENT_TEXT_VERSIONS.third_party_ai })}
      </p>
    </div>
  );
}

/**
 * Said beside the statement (checkbox or dialog) to a member who agreed to
 * an earlier wording: why the box is empty. One component, so the sentence
 * and its styling live in one place; callers decide with consent.needsReagree.
 */
export function AiConsentReagreeNote({ id, className = "" }: { id?: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <p id={id} role="note" className={`text-sm text-brand-700 dark:text-brand-300 ${className}`}>
      {t("aiConsentReagree")}
    </p>
  );
}

/**
 * The statement inline, as a checkbox: asked once per person and wording
 * (the server remembers it), so the AI step shows it only until it is
 * given. Unticked by default; ticking it records nothing by itself, the
 * consent is recorded right before the AI call it allows.
 */
export function AiConsentCheckbox({
  providers,
  checked,
  onChange,
  disabled = false,
  reagree = false,
}: {
  providers: readonly string[];
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** consent.needsReagree: say that the wording changed. */
  reagree?: boolean;
}) {
  const { t } = useTranslation();
  const named = providers.map(providerLabel).join(", ");
  return (
    <div className="rounded-xl border border-gray-200 p-3 sm:p-4 dark:border-line">
      <Checkbox
        size="md"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby="ai-consent-inline-body"
        label={<span className="text-sm font-medium">{t("aiConsentCheck", { providers: named })}</span>}
      />
      <div className="mt-2 space-y-2 ps-8">
        {reagree && <AiConsentReagreeNote />}
        <AiConsentText providers={providers} id="ai-consent-inline-body" />
      </div>
    </div>
  );
}

/**
 * The statement as a dialog, before an AI call that is not in the AI step.
 * "Not now" is focused first: agreeing is the one answer that sends a photo
 * somewhere, so it is never what a stray Enter does.
 */
export function AiConsentDialog({
  open,
  purpose,
  providers,
  reagree = false,
  onAnswer,
}: {
  open: boolean;
  /** What the owner pressed, in words ("Find the points with AI"). */
  purpose: string;
  providers: readonly string[];
  /** consent.needsReagree: say that the wording changed. */
  reagree?: boolean;
  onAnswer: (agreed: boolean) => void;
}) {
  const { t } = useTranslation();
  const named = providers.map(providerLabel).join(", ");
  return (
    <Dialog open={open} onClose={() => onAnswer(false)} labelledBy="ai-consent-title" describedBy="ai-consent-body">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
          <Icon name="shield" className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 id="ai-consent-title" className="text-lg font-semibold">
            {t("aiConsentTitle", { providers: named })}
          </h2>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t("aiConsentFor", { purpose })}</p>
        </div>
      </div>
      <div className="mt-4 space-y-2">
        {reagree && <AiConsentReagreeNote />}
        <AiConsentText providers={providers} id="ai-consent-body" />
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <Button variant="secondary" size="lg" onClick={() => onAnswer(false)} data-autofocus>
          {t("aiConsentDecline")}
        </Button>
        <Button size="lg" className="px-5" onClick={() => onAnswer(true)}>
          {t("aiConsentAgree")}
        </Button>
      </div>
    </Dialog>
  );
}
