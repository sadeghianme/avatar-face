import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { AuthShell } from "./AuthShell";

interface InviteInfo {
  org_name: string;
  email: string;
  role: string;
}

export function AcceptInvitePage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const { data: invite, isLoading } = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.get<InviteInfo>(`/invitations/${token}`),
    retry: false,
  });

  const accept = async () => {
    try {
      await api.post(`/invitations/${token}/accept`);
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
        <p className="field-error">{t("error")}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-gray-700 dark:text-gray-300">
            {t("joinOrg", { org: invite.org_name, role: t(`roles.${invite.role}`) })}
          </p>
          {error && <p className="field-error">{error}</p>}
          {user ? (
            <button className="btn-primary" onClick={() => void accept()}>
              {t("accept")}
            </button>
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
