import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";

import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { AuthShell } from "./AuthShell";

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
    <AuthShell title={t("login")}>
      <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
        <div>
          <label className="label" htmlFor="identifier">{t("usernameOrEmail")}</label>
          <input id="identifier" className="input" autoComplete="username"
            {...register("username_or_email")} />
          {errors.username_or_email && (
            <p className="field-error">{errors.username_or_email.message}</p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="password">{t("password")}</label>
          <input id="password" type="password" className="input" autoComplete="current-password"
            {...register("password")} />
          {errors.password && <p className="field-error">{errors.password.message}</p>}
        </div>
        {errors.root && <p className="field-error">{errors.root.message}</p>}
        <button type="submit" disabled={isSubmitting} className="btn-primary">
          {t("login")}
        </button>
        <p className="text-center text-sm text-gray-500">
          {t("noAccount")}{" "}
          <Link to="/register" className="text-brand-600 hover:underline">
            {t("register")}
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
