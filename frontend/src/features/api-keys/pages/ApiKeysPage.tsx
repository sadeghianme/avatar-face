import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { api, ApiError } from "@/lib/api";
import { useOrg } from "@/providers/org";
import type { ApiKeyInfo } from "@/lib/types";

interface Created {
  api_key: ApiKeyInfo;
  plaintext: string;
}

export function ApiKeysPage() {
  const { t } = useTranslation();
  const { current } = useOrg();
  const queryClient = useQueryClient();
  const orgId = current?.id;
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [revealed, setRevealed] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = current?.role === "owner" || current?.role === "admin";

  const { data: keys } = useQuery({
    queryKey: ["api-keys", orgId],
    queryFn: () => api.get<ApiKeyInfo[]>(`/orgs/${orgId}/api-keys`),
    enabled: Boolean(orgId) && canManage,
  });

  const createKey = async () => {
    setError(null);
    try {
      const created = await api.post<Created>(`/orgs/${orgId}/api-keys`, {
        name: name.trim() || "Widget key",
        allowed_domains: domains
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
      });
      setRevealed(created);
      setName("");
      setDomains("");
      await queryClient.invalidateQueries({ queryKey: ["api-keys", orgId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    }
  };

  if (!canManage) {
    return <p className="text-gray-500">{t("apiKeys")}: {t(`roles.${current?.role ?? "member"}`)} ⛔</p>;
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">{t("apiKeys")}</h1>

      <form
        className="card mb-6 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void createKey();
        }}
      >
        <div className="min-w-40 flex-1">
          <label className="label" htmlFor="key-name">{t("keyName")}</label>
          <input
            id="key-name"
            className="input"
            placeholder="Production widget"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="min-w-56 flex-[2]">
          <label className="label" htmlFor="key-domains">{t("allowedDomains")}</label>
          <input
            id="key-domains"
            className="input"
            placeholder="example.com, *.example.org"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary">
          {t("createApiKey")}
        </button>
      </form>
      {error && <p className="field-error mb-4">{error}</p>}

      {revealed && (
        <div className="card mb-6 border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20">
          {/* Reveal-once: the plaintext only exists in this response. */}
          <p className="mb-2 text-sm font-medium text-emerald-800 dark:text-emerald-200">
            {t("keyCreatedOnce")}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-white px-3 py-2 text-sm dark:bg-panel">
              {revealed.plaintext}
            </code>
            <button
              className="btn-secondary"
              onClick={() => void navigator.clipboard.writeText(revealed.plaintext)}
            >
              {t("copy")}
            </button>
            <button className="btn-secondary" onClick={() => setRevealed(null)}>
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="card p-0">
        <table className="w-full text-sm">
          <tbody>
            {keys?.map((key) => (
              <tr
                key={key.id}
                className={`border-b border-gray-100 last:border-0 dark:border-line ${
                  key.revoked_at ? "opacity-50" : ""
                }`}
              >
                <td className="px-5 py-3">
                  <div className="font-medium">{key.name}</div>
                  <code className="text-xs text-gray-400">{key.prefix}…</code>
                </td>
                <td className="px-5 py-3 text-xs text-gray-500">
                  {key.allowed_domains || "any origin"}
                </td>
                <td className="px-5 py-3 text-end">
                  {!key.revoked_at && (
                    <button
                      className="text-sm text-red-600 hover:underline"
                      onClick={async () => {
                        await api.delete(`/orgs/${orgId}/api-keys/${key.id}`);
                        await queryClient.invalidateQueries({ queryKey: ["api-keys", orgId] });
                      }}
                    >
                      {t("revoke")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
