import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../components/Icon";

import { api, ApiError } from "../lib/api";
import { useOrg } from "../lib/org";
import { useTheme } from "../lib/theme";
import type { Integration, Usage } from "../lib/types";

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { current } = useOrg();
  const { theme, toggle } = useTheme();
  const queryClient = useQueryClient();
  const orgId = current?.id;
  const [orgName, setOrgName] = useState<string | null>(null);
  const isOwner = current?.role === "owner";

  const { data: usage } = useQuery({
    queryKey: ["usage", orgId],
    queryFn: () => api.get<Usage>(`/orgs/${orgId}/usage`),
    enabled: Boolean(orgId),
  });

  const renameOrg = async () => {
    if (!orgName?.trim() || !orgId) return;
    await api.patch(`/orgs/${orgId}`, { name: orgName.trim() });
    await queryClient.invalidateQueries({ queryKey: ["orgs"] });
    setOrgName(null);
  };

  const pct = usage ? Math.min(100, (usage.chars_used / usage.char_limit) * 100) : 0;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t("settings")}</h1>

      {/* Org rename */}
      <section className="card">
        <h2 className="mb-3 font-medium">{t("orgSettings")}</h2>
        <div className="flex gap-2">
          <input
            aria-label={t("orgName")}
            className="input flex-1"
            value={orgName ?? current?.name ?? ""}
            onChange={(e) => setOrgName(e.target.value)}
            disabled={!isOwner && current?.role !== "admin"}
          />
          <button
            className="btn-primary"
            disabled={orgName === null}
            onClick={() => void renameOrg()}
          >
            {t("save")}
          </button>
        </div>
      </section>

      {/* Usage */}
      <section className="card">
        <h2 className="mb-3 font-medium">{t("usage")}</h2>
        <div className="mb-2 h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          <div
            className={`h-full ${pct > 90 ? "bg-red-500" : "bg-brand-600"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-sm text-gray-500">
          {t("charsUsed", {
            used: usage?.chars_used?.toLocaleString() ?? "0",
            limit: usage?.char_limit?.toLocaleString() ?? "—",
          })}
        </p>
        {usage && usage.by_provider.length > 0 && (
          <ul className="mt-3 text-xs text-gray-400">
            {usage.by_provider.map((row) => (
              <li key={row.provider}>
                {row.provider}: {row.syntheses}× · {row.chars.toLocaleString()} chars
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Appearance */}
      <section className="card flex flex-wrap items-center gap-6">
        <div>
          <h2 className="mb-2 font-medium">{t("theme")}</h2>
          <button className="btn-secondary" onClick={toggle}>
            <Icon name={theme === "dark" ? "sun" : "moon"} className="me-1.5 inline h-4 w-4" />
            {theme === "dark" ? t("light") : t("dark")}
          </button>
        </div>
        <div>
          <h2 className="mb-2 font-medium">{t("language")}</h2>
          <select
            aria-label={t("language")}
            className="input w-auto"
            value={i18n.language}
            onChange={(e) => void i18n.changeLanguage(e.target.value)}
          >
            <option value="en">English</option>
            <option value="fr">Français</option>
          </select>
        </div>
      </section>

      {isOwner && orgId && <ProvidersCard orgId={orgId} kind="voice" />}
      {isOwner && orgId && <ProvidersCard orgId={orgId} kind="image" />}
      {isOwner && orgId && <ProvidersCard orgId={orgId} kind="model" />}
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  azure_speech_key: "Subscription key",
  azure_speech_region: "Region",
  elevenlabs_api_key: "API key",
  google_tts_credentials_json: "Service-account JSON (or file path)",
  openai_api_key: "API key",
  gemini_api_key: "API key",
  avaturn_api_token: "Project API token",
};

function ProvidersCard({ orgId, kind }: { orgId: string; kind: "voice" | "image" | "model" }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const { data: integrations } = useQuery({
    queryKey: ["integrations", orgId],
    queryFn: () => api.get<Integration[]>(`/orgs/${orgId}/integrations`),
  });

  const saveProvider = async (integration: Integration) => {
    const values: Record<string, string> = {};
    for (const field of integration.fields) {
      if (field.name in drafts) values[field.name] = drafts[field.name];
    }
    if (!Object.keys(values).length) return;
    setError(null);
    try {
      await api.put(`/orgs/${orgId}/integrations`, { values });
      setDrafts((d) => {
        const next = { ...d };
        for (const key of Object.keys(values)) delete next[key];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ["integrations", orgId] });
      await queryClient.invalidateQueries({ queryKey: ["tts-providers"] });
      await queryClient.invalidateQueries({ queryKey: ["imagegen"] });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    }
  };

  const testProvider = async (provider: string) => {
    const result = await api.post<{ ok: boolean; voices?: number; error?: string }>(
      `/orgs/${orgId}/integrations/${provider}/test`
    );
    setTestResult((r) => ({
      ...r,
      [provider]: result.ok ? `✓ ${result.voices} voices` : `✗ ${result.error}`,
    }));
  };

  return (
    <section className="card">
      <h2 className="mb-1 font-medium">
        {t(`${kind}Providers`)}
      </h2>
      <p className="mb-4 text-[13px] text-gray-500 dark:text-gray-400">
        {t(`${kind}ProvidersHint`)}
      </p>
      {error && <p className="field-error mb-3">{error}</p>}
      <div className="flex flex-col gap-5">
        {integrations?.filter((i) => i.kind === kind).map((integration) => (
          <div
            key={integration.provider}
            className="rounded-lg border border-gray-200 p-4 dark:border-line"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="font-medium capitalize">{integration.provider}</span>
              <span
                className={`text-xs ${integration.configured ? "text-emerald-600" : "text-gray-400"}`}
              >
                {integration.configured ? "configured" : "not configured"}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {integration.fields.map((field) => (
                <div key={field.name} className="flex items-center gap-2">
                  <label className="w-44 shrink-0 text-xs text-gray-500" htmlFor={field.name}>
                    {FIELD_LABELS[field.name] ?? field.name}
                    {field.source !== "unset" && (
                      <span className="ms-1 text-gray-400">({field.source})</span>
                    )}
                  </label>
                  <input
                    id={field.name}
                    className="input flex-1"
                    type="password"
                    autoComplete="off"
                    placeholder={field.masked || "—"}
                    value={drafts[field.name] ?? ""}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [field.name]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                className="btn-primary px-3 py-1 text-xs"
                onClick={() => void saveProvider(integration)}
              >
                {t("save")}
              </button>
              <button
                className="btn-secondary px-3 py-1 text-xs"
                onClick={() => void testProvider(integration.provider)}
              >
                {t("test")}
              </button>
              {testResult[integration.provider] && (
                <span className="text-xs text-gray-500">
                  {testResult[integration.provider]}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
