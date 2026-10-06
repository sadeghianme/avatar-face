import { useTranslation } from "react-i18next";

import { Card } from "@/components/ui/Card";
import { FieldError } from "@/components/ui/FieldError";
import { Switch } from "@/components/ui/Switch";
import { useSetThirdPartyAi } from "@/features/settings/api";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errorMessage";
import type { Org } from "@/lib/types";

/**
 * "Allow third-party AI (Google)": the organization's switch for every step
 * that sends a picture to Google (touch-ups, regenerating, stylising,
 * generating, finding an animal's points). Owners and admins change it;
 * members see how it is set, and why an AI step may be missing.
 *
 * Off takes effect at once, on the server: a step already on screen is
 * refused (403 third_party_ai_disabled) rather than trusted to hide itself,
 * so the open wizard, the consent terms and the org are all refreshed
 * (useSetThirdPartyAi).
 */
export function AiSwitchCard({ org }: { org: Org }) {
  const { t } = useTranslation();
  const setAi = useSetThirdPartyAi(org.id);
  const canChange = org.role === "owner" || org.role === "admin";
  const on = org.third_party_ai_enabled ?? true;
  const refusal =
    setAi.error instanceof ApiError && setAi.error.code === "insufficient_role"
      ? t("aiSwitchNotAllowed")
      : setAi.error && errorMessage(setAi.error, t("error"));

  return (
    <Card as="section" aria-labelledby="ai-switch-heading">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="ai-switch-heading" className="font-medium">
            {t("aiSwitchTitle")}
          </h2>
          <p id="ai-switch-hint" className="mt-1 text-[13px] text-gray-500 max-lg:text-sm dark:text-gray-400">
            {t("aiSwitchHint")}
          </p>
        </div>
        <Switch
          checked={on}
          onChange={(next) => setAi.mutate(next)}
          aria-labelledby="ai-switch-heading"
          aria-describedby="ai-switch-hint"
          disabled={!canChange || setAi.isPending}
        />
      </div>
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        {on ? t("aiSwitchOn") : t("aiSwitchOff")}
        {!canChange && <> {t("aiSwitchAdminsOnly")}</>}
      </p>
      {refusal && <FieldError className="mt-2">{refusal}</FieldError>}
    </Card>
  );
}
