import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { AuthShell } from "@/features/auth/components/AuthShell";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/providers/auth";

const schema = z.object({
  email: z.string().email(),
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/),
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
      navigate("/app", { replace: true });
    } catch (err) {
      setError("root", { message: err instanceof ApiError ? err.detail : t("error") });
    }
  };

  return (
    <AuthShell title={t("register")}>
      <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
        <Field id="email" label={t("email")} error={errors.email?.message}>
          <Input type="email" {...register("email")} />
        </Field>
        <Field id="username" label={t("username")} error={errors.username?.message}>
          <Input {...register("username")} />
        </Field>
        <Field id="password" label={t("password")} error={errors.password?.message}>
          <Input type="password" autoComplete="new-password" {...register("password")} />
        </Field>
        <Field id="display_name" label={t("displayName")}>
          <Input {...register("display_name")} />
        </Field>
        {errors.root && <p className="field-error">{errors.root.message}</p>}
        <Button type="submit" disabled={isSubmitting}>
          {t("register")}
        </Button>
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
