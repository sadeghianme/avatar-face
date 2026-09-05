import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";

import { ApiError } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { AuthShell } from "@/features/auth/components/AuthShell";

const schema = z.object({
  username_or_email: z.string().min(1),
  password: z.string().min(1),
});
type Form = z.infer<typeof schema>;

export function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname: string } } };
  const [showPassword, setShowPassword] = useState(false);
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

  return (
    <AuthShell title={t("welcomeBack")} subtitle={t("loginSubtitle")}>
      <form className="flex flex-col gap-5" onSubmit={handleSubmit(onSubmit)}>
        <div>
          <label className="label" htmlFor="identifier">
            {t("usernameOrEmail")}
          </label>
          <input
            id="identifier"
            className="input py-2.5"
            autoComplete="username"
            autoFocus
            placeholder={t("usernamePlaceholder")}
            {...register("username_or_email")}
          />
          {errors.username_or_email && (
            <p className="field-error">{errors.username_or_email.message}</p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="password">
            {t("password")}
          </label>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              className="input py-2.5 pe-16"
              autoComplete="current-password"
              placeholder="********"
              {...register("password")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute inset-y-0 end-0 px-3 text-xs font-medium text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
            >
              {showPassword ? t("hide") : t("show")}
            </button>
          </div>
          {errors.password && <p className="field-error">{errors.password.message}</p>}
        </div>

        {errors.root && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {errors.root.message}
          </p>
        )}

        <button type="submit" disabled={isSubmitting} className="btn-primary py-2.5 text-base">
          {isSubmitting ? t("loading") : t("login")}
        </button>

        <p className="text-center text-sm text-gray-500 dark:text-gray-400">
          <Link
            to="/forgot-password"
            className="font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            {t("forgotPassword")}
          </Link>
        </p>
        <p className="mt-2 text-center text-sm text-gray-500 dark:text-gray-400">
          {t("noAccount")}{" "}
          <Link to="/register" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
            {t("register")}
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
