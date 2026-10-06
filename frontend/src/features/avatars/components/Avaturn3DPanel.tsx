import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { api, ApiError } from "@/lib/api";
import type { Avatar } from "@/lib/types";

/**
 * Build a 3D avatar in Avaturn's editor, then import the GLB it hands back.
 *
 * The editor runs in an iframe and the user's photos go straight from their
 * browser to Avaturn — this app never holds them. When they accept an
 * avatar, Avaturn posts a message containing the exported GLB URL, which we
 * pass to the ordinary from-url importer (avaturn.me is already an allowed
 * host), so the result is an avatar like any other.
 */
export function Avaturn3DPanel({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [sessionUrl, setSessionUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await api.post<{ url: string }>(`/orgs/${orgId}/avatars/avaturn-session`, {});
      setSessionUrl(session.url);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!sessionUrl) return;

    const importFrom = async (url: string) => {
      setBusy(true);
      try {
        const created = await api.post<Avatar>(`/orgs/${orgId}/avatars/from-url`, {
          url,
          name: "3D avatar",
        });
        await queryClient.invalidateQueries({ queryKey: ["avatars", orgId] });
        navigate(`/avatars/${created.id}`);
      } catch (err) {
        setError(err instanceof ApiError ? err.detail : t("error"));
        setBusy(false);
      }
    };

    const onMessage = (event: MessageEvent) => {
      // Only ever trust messages from the editor we opened. Without this
      // check any page in any tab could hand us a URL to import.
      if (new URL(sessionUrl).origin !== event.origin) return;
      let data = event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      const url: string | undefined = data?.url ?? data?.data?.url;
      if (!url || data?.eventName === undefined) return;
      void importFrom(url);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sessionUrl, orgId, navigate, queryClient, t]);

  if (sessionUrl) {
    return (
      <Card padding="none">
        <iframe
          ref={frameRef}
          src={sessionUrl}
          title={t("avaturnTitle")}
          allow="camera *; microphone *; clipboard-write"
          className="h-[560px] w-full rounded-2xl border-0"
        />
        {busy && (
          <p className="flex items-center gap-2 p-3 text-sm text-gray-500">
            <Spinner className="h-4 w-4" />
            {t("avaturnImporting")}
          </p>
        )}
        {error && <p className="field-error p-3">{error}</p>}
      </Card>
    );
  }

  return (
    <Card className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-[13px] text-gray-500 dark:text-gray-400">{t("avaturnBody")}</p>
      <Button className="shrink-0" onClick={() => void start()} loading={busy}>
        {t("avaturnStart")}
      </Button>
      {error && <p className="field-error w-full">{error}</p>}
    </Card>
  );
}
