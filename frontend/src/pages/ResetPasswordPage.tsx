import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { AuthShell } from "./AuthShell";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

const MIN_LENGTH = 8;

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { adoptSession } = useAuth();
  const token = params.get("token") ?? "";

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
      const tokens = await api.post<{ access_token: string; refresh_token: string }>(
        "/auth/reset-password",
        { token, password }
      );
      // Straight in. Someone who has just proved control of the mailbox and
      // chosen a password should not be asked to type it again. Through the
      // auth context, not setTokens: writing storage alone leaves the context
      // believing nobody is signed in, and /app bounces straight back to
      // /login.
      await adoptSession(tokens);
      navigate("/app", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthShell title={t("resetInvalidTitle")} subtitle={t("resetInvalidBody")}>
        <Link
          to="/forgot-password"
          className="font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          {t("sendResetLink")}
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t("resetTitle")} subtitle={t("resetSubtitle")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div>
          <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
            {t("newPassword")}
          </label>
          <div className="relative">
            <input
              id="password"
              type={show ? "text" : "password"}
              required
              autoFocus
              autoComplete="new-password"
              className="input pe-16"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="absolute end-3 top-1/2 -translate-y-1/2 text-[13px] text-gray-500 hover:text-gray-900 dark:hover:text-gray-200"
            >
              {show ? t("hide") : t("show")}
            </button>
          </div>
          {tooShort && <p className="field-error mt-1.5">{t("passwordTooShort")}</p>}
        </div>

        <div>
          <label htmlFor="confirm" className="mb-1.5 block text-sm font-medium">
            {t("confirmPassword")}
          </label>
          <input
            id="confirm"
            type={show ? "text" : "password"}
            required
            autoComplete="new-password"
            className="input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch && <p className="field-error mt-1.5">{t("passwordsDoNotMatch")}</p>}
        </div>

        {error && <p className="field-error">{error}</p>}

        <button className="btn-primary w-full" disabled={busy || !ready}>
          {busy ? t("loading") : t("setNewPassword")}
        </button>
      </form>
    </AuthShell>
  );
}
