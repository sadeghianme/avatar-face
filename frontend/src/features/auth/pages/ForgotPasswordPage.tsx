import { useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useForgotPassword } from "@/features/auth/api";
import { AuthShell } from "@/features/auth/components/AuthShell";
import { useT } from "@/i18n";

export function ForgotPasswordPage() {
  const { t } = useT();
  const forgot = useForgotPassword();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await forgot.mutateAsync(email);
    } catch {
      // Deliberately ignored. The server answers the same way whether or not
      // the address exists, and showing an error here would put back exactly
      // the signal that design removes.
    } finally {
      setBusy(false);
      setSent(true);
    }
  };

  if (sent) {
    return (
      <AuthShell title={t("checkYourInbox")} subtitle={t("resetSentBody", { email })}>
        <Link
          to="/login"
          className="font-medium text-brand-600 hover:underline coarse:inline-flex coarse:min-h-11 coarse:items-center dark:text-brand-400"
        >
          {t("backToLogin")}
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t("forgotTitle")} subtitle={t("forgotSubtitle")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field id="email" label={t("email")}>
          <Input
            type="email"
            required
            autoFocus
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        <Button type="submit" fullWidth disabled={busy || !email.trim()}>
          {busy ? t("loading") : t("sendResetLink")}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
        <Link
          to="/login"
          className="font-medium text-brand-600 hover:underline coarse:inline-flex coarse:min-h-11 coarse:items-center dark:text-brand-400"
        >
          {t("backToLogin")}
        </Link>
      </p>
    </AuthShell>
  );
}
