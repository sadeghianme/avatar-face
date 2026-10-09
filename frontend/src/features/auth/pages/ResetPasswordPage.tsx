import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { FieldError } from "@/components/ui/FieldError";
import { Input } from "@/components/ui/Input";
import { useResetPassword } from "@/features/auth/api";
import { AuthShell } from "@/features/auth/components/AuthShell";
import { useT } from "@/i18n";
import { useAuth } from "@/providers/auth";

const MIN_LENGTH = 8;

export function ResetPasswordPage() {
  const { t } = useT();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { adoptSession } = useAuth();
  const token = params.get("token") ?? "";

  const reset = useResetPassword();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= MIN_LENGTH && confirm === password && !!token;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await reset.mutateAsync({ token, password });
      // Straight in. Someone who has just proved control of the mailbox and
      // chosen a password should not be asked to type it again. Through the
      // auth context, not setAccessToken: the token alone leaves the context
      // believing nobody is signed in, and /app bounces straight back to
      // /login.
      await adoptSession(session);
      navigate("/app", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthShell title={t("resetInvalidTitle")} subtitle={t("resetInvalidBody")}>
        <Link to="/forgot-password" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
          {t("sendResetLink")}
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t("resetTitle")} subtitle={t("resetSubtitle")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field id="password" label={t("newPassword")} error={tooShort && t("passwordTooShort")}>
          {/* One Show for both fields: the two are compared by eye. */}
          <Input
            type={show ? "text" : "password"}
            required
            autoFocus
            autoComplete="new-password"
            className="pe-16"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            end={
              <Button
                variant="text"
                onClick={() => setShow((v) => !v)}
                className="absolute end-3 top-1/2 -translate-y-1/2 justify-center text-[13px] coarse:min-w-11"
              >
                {show ? t("hide") : t("show")}
              </Button>
            }
          />
        </Field>

        <Field id="confirm" label={t("confirmPassword")} error={mismatch && t("passwordsDoNotMatch")}>
          <Input
            type={show ? "text" : "password"}
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>

        {error && <FieldError>{error}</FieldError>}

        <Button type="submit" fullWidth disabled={busy || !ready}>
          {busy ? t("loading") : t("setNewPassword")}
        </Button>
      </form>
    </AuthShell>
  );
}
