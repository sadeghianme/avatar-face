import { zodResolver } from "@hookform/resolvers/zod";
import { KeyboardEvent, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";

import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { AuthShell } from "@/features/auth/components/AuthShell";

// Messages are i18n keys, translated where they are shown.
const schema = z.object({
  username_or_email: z.string().trim().min(1, "identifierRequired"),
  password: z.string().min(1, "passwordRequired"),
});
type Form = z.infer<typeof schema>;

export function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname: string } } };
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: Form) => {
    try {
      await login(data.username_or_email, data.password);
      navigate(location.state?.from?.pathname ?? "/app", { replace: true });
    } catch (err) {
      setError("root", {
        message: err instanceof ApiError ? err.detail : t("error"),
      });
    }
  };

  const password = register("password");
  const readCapsLock = (event: KeyboardEvent<HTMLInputElement>) =>
    setCapsLock(event.getModifierState?.("CapsLock") ?? false);

  return (
    <AuthShell title={t("welcomeBack")} subtitle={t("loginSubtitle")}>
      <form className="flex flex-col gap-5" onSubmit={handleSubmit(onSubmit)} noValidate>
        <div>
          <label className="label" htmlFor="identifier">
            {t("usernameOrEmail")}
          </label>
          <div className="relative">
            <Icon
              name="user"
              className="pointer-events-none absolute start-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-gray-400"
            />
            <input
              id="identifier"
              className="input h-11 ps-10 text-[15px]"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              placeholder={t("usernamePlaceholder")}
              aria-invalid={errors.username_or_email ? true : undefined}
              aria-describedby={errors.username_or_email ? "identifier-error" : undefined}
              {...register("username_or_email")}
            />
          </div>
          {errors.username_or_email && (
            <p id="identifier-error" className="field-error">
              {t(errors.username_or_email.message ?? "error")}
            </p>
          )}
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-3">
            <label className="label" htmlFor="password">
              {t("password")}
            </label>
            <Link
              to="/forgot-password"
              className="text-[13px] font-medium text-brand-600 hover:underline coarse:-my-3 coarse:inline-block coarse:py-3 dark:text-brand-400"
            >
              {t("forgotPassword")}
            </Link>
          </div>
          <div className="relative">
            <Icon
              name="lock"
              className="pointer-events-none absolute start-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-gray-400"
            />
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              className="input h-11 pe-11 ps-10 text-[15px]"
              autoComplete="current-password"
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={errors.password ? "password-error" : capsLock ? "caps-lock" : undefined}
              onKeyDown={readCapsLock}
              onKeyUp={readCapsLock}
              {...password}
              onBlur={(event) => {
                setCapsLock(false);
                void password.onBlur(event);
              }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? t("hidePassword") : t("showPassword")}
              aria-pressed={showPassword}
              className="absolute inset-y-0 end-0 grid w-11 place-items-center rounded-e-lg text-gray-400 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 dark:hover:text-gray-200"
            >
              <Icon name={showPassword ? "eyeOff" : "eye"} className="h-[18px] w-[18px]" />
            </button>
          </div>
          {errors.password && (
            <p id="password-error" className="field-error">
              {t(errors.password.message ?? "error")}
            </p>
          )}
          {capsLock && (
            <p id="caps-lock" role="status" className="mt-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-amber-700 dark:text-amber-400">
              <Icon name="capsLock" className="h-3.5 w-3.5" />
              {t("capsLockOn")}
            </p>
          )}
        </div>

        {errors.root && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-xl bg-red-50 px-3.5 py-3 text-[14px] text-red-700 ring-1 ring-red-600/10 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/20"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {errors.root.message}
          </div>
        )}

        <button type="submit" disabled={isSubmitting} className="btn-primary h-11 text-[15px] font-semibold">
          {isSubmitting ? (
            <>
              <Spinner className="h-4 w-4" />
              {t("signingIn")}
            </>
          ) : (
            t("login")
          )}
        </button>

        <div className="mt-2 flex items-center gap-3 text-[13px] text-gray-400" aria-hidden="true">
          <span className="h-px flex-1 bg-black/[0.08] dark:bg-white/10" />
          {t("newHere")}
          <span className="h-px flex-1 bg-black/[0.08] dark:bg-white/10" />
        </div>
        <Link to="/register" className="btn-secondary h-11 text-[15px] font-semibold">
          {t("createAccountCta")}
        </Link>
      </form>
    </AuthShell>
  );
}
