import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";

import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { AuthShell } from "./AuthShell";

const schema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(8).max(128),
  display_name: z.string().max(128).optional(),
});
type Form = z.infer<typeof schema>;

export function RegisterPage() {
  const { t } = useTranslation();
  const { register: signup } = useAuth();
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: Form) => {
    try {
      await signup(data.email, data.username, data.password, data.display_name);
      navigate("/", { replace: true });
    } catch (err) {
      setError("root", { message: err instanceof ApiError ? err.detail : t("error") });
    }
  };

  return (
    <AuthShell title={t("register")}>
      <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
        <div>
          <label className="label" htmlFor="email">{t("email")}</label>
          <input id="email" type="email" className="input" {...register("email")} />
          {errors.email && <p className="field-error">{errors.email.message}</p>}
        </div>
        <div>
          <label className="label" htmlFor="username">{t("username")}</label>
          <input id="username" className="input" {...register("username")} />
          {errors.username && <p className="field-error">{errors.username.message}</p>}
        </div>
        <div>
          <label className="label" htmlFor="password">{t("password")}</label>
          <input id="password" type="password" className="input" autoComplete="new-password"
            {...register("password")} />
          {errors.password && <p className="field-error">{errors.password.message}</p>}
        </div>
        <div>
          <label className="label" htmlFor="display_name">{t("displayName")}</label>
          <input id="display_name" className="input" {...register("display_name")} />
        </div>
        {errors.root && <p className="field-error">{errors.root.message}</p>}
        <button type="submit" disabled={isSubmitting} className="btn-primary">
          {t("register")}
        </button>
        <p className="text-center text-sm text-gray-500">
          {t("haveAccount")}{" "}
          <Link to="/login" className="text-brand-600 hover:underline">
            {t("login")}
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
