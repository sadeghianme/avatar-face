import { zodResolver } from "@hookform/resolvers/zod";
import { KeyboardEvent, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { AuthShell } from "@/features/auth/components/AuthShell";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/providers/auth";

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
        <Field
          id="identifier"
          label={t("usernameOrEmail")}
          error={errors.username_or_email && t(errors.username_or_email.message ?? "error")}
        >
          <Input
            icon="user"
            className="h-11 text-[15px]"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            placeholder={t("usernamePlaceholder")}
            {...register("username_or_email")}
          />
        </Field>

        <Field
          id="password"
          label={t("password")}
          labelAside={
            <Link
              to="/forgot-password"
              className="text-[13px] font-medium text-brand-600 hover:underline coarse:-my-3 coarse:inline-block coarse:py-3 dark:text-brand-400"
            >
              {t("forgotPassword")}
            </Link>
          }
          error={errors.password && t(errors.password.message ?? "error")}
        >
          <PasswordInput
            icon="lock"
            showLabel={t("showPassword")}
            hideLabel={t("hidePassword")}
            className="h-11 text-[15px]"
            autoComplete="current-password"
            aria-describedby={capsLock ? "caps-lock" : undefined}
            onKeyDown={readCapsLock}
            onKeyUp={readCapsLock}
            {...password}
            onBlur={(event) => {
              setCapsLock(false);
              void password.onBlur(event);
            }}
          />
          {capsLock && (
            <p
              id="caps-lock"
              role="status"
              className="mt-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-amber-700 dark:text-amber-400"
            >
              <Icon name="capsLock" className="h-3.5 w-3.5" />
              {t("capsLockOn")}
            </p>
          )}
        </Field>

        {errors.root && (
          <Banner appearance="soft" tone="danger" icon="alert" role="alert">
            {errors.root.message}
          </Banner>
        )}

        <Button type="submit" loading={isSubmitting} className="h-11 text-[15px] font-semibold">
          {isSubmitting ? t("signingIn") : t("login")}
        </Button>

        <div className="mt-2 flex items-center gap-3 text-[13px] text-gray-400" aria-hidden="true">
          <span className="h-px flex-1 bg-black/[0.08] dark:bg-white/10" />
          {t("newHere")}
          <span className="h-px flex-1 bg-black/[0.08] dark:bg-white/10" />
        </div>
        <ButtonLink to="/register" variant="secondary" className="h-11 text-[15px] font-semibold">
          {t("createAccountCta")}
        </ButtonLink>
      </form>
    </AuthShell>
  );
}
