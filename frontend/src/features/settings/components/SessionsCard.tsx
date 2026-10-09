import { useState } from "react";

import { Card } from "@/components/ui/Card";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { FieldError } from "@/components/ui/FieldError";
import { useT } from "@/i18n";
import { useAuth } from "@/providers/auth";

/**
 * "Log out everywhere": every session of the account ends on the server
 * (POST /auth/logout-all), this one included, so a forgotten computer or a
 * copied session is signed out at its next request. Asks once, in place;
 * once done, the app goes back to the login page (the auth provider has
 * nobody signed in).
 */
export function SessionsCard() {
  const { t } = useT();
  const { logoutEverywhere } = useAuth();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirm = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await logoutEverywhere();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <Card as="section" aria-labelledby="sessions-heading">
      <h2 id="sessions-heading" className="font-medium">
        {t("sessionsTitle")}
      </h2>
      <p className="mb-3 mt-1 text-[13px] text-gray-500 max-lg:text-sm dark:text-gray-400">{t("sessionsHint")}</p>
      <ConfirmButton
        icon="lock"
        label={t("logoutEverywhere")}
        question={t("logoutEverywhereAsk")}
        confirmLabel={t("logoutEverywhere")}
        cancelLabel={t("cancel")}
        size="md"
        busy={busy}
        onConfirm={() => void confirm()}
      />
      {failed && <FieldError className="mt-2">{t("logoutEverywhereFailed")}</FieldError>}
    </Card>
  );
}
