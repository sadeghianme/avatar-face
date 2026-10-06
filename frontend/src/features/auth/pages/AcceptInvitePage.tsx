import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/FieldError";
import { useAcceptInvite, useInvite } from "@/features/auth/api";
import { AuthShell } from "@/features/auth/components/AuthShell";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/providers/auth";

export function AcceptInvitePage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const { data: invite, isLoading } = useInvite(token);
  const acceptInvite = useAcceptInvite(token);

  const accept = async () => {
    try {
      await acceptInvite.mutateAsync();
      navigate("/app", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    }
  };

  return (
    <AuthShell title={t("acceptInvite")}>
      {isLoading || loading ? (
        <p className="text-gray-500">{t("loading")}</p>
      ) : !invite ? (
        <FieldError>{t("error")}</FieldError>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-gray-700 dark:text-gray-300">
            {t("joinOrg", { org: invite.org_name, role: t(`roles.${invite.role}`) })}
          </p>
          {error && <FieldError>{error}</FieldError>}
          {user ? (
            <Button onClick={() => void accept()}>{t("accept")}</Button>
          ) : (
            <p className="text-sm text-gray-500">
              <Link className="text-brand-600 hover:underline" to="/login">
                {t("login")}
              </Link>{" "}
              ({invite.email})
            </p>
          )}
        </div>
      )}
    </AuthShell>
  );
}
