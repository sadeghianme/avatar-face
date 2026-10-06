import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useIntegrations, useSaveIntegrations, useTestIntegration } from "@/features/settings/api";
import { errorMessage } from "@/lib/errorMessage";
import type { Integration } from "@/lib/types";

const FIELD_LABELS: Record<string, string> = {
  azure_speech_key: "Subscription key",
  azure_speech_region: "Region",
  elevenlabs_api_key: "API key",
  google_tts_credentials_json: "Service-account JSON (or file path)",
  openai_api_key: "API key",
  gemini_api_key: "API key",
  avaturn_api_token: "Project API token",
};

/**
 * One kind of provider (voice, image, model) and the credentials of each:
 * written only (a field shows what is set, masked), saved per provider,
 * tested on demand. Owners only.
 */
export function ProvidersCard({ orgId, kind }: { orgId: string; kind: "voice" | "image" | "model" }) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const { data: integrations } = useIntegrations(orgId);
  const save = useSaveIntegrations(orgId);
  const test = useTestIntegration(orgId);

  const saveProvider = (integration: Integration) => {
    const values: Record<string, string> = {};
    for (const field of integration.fields) {
      if (field.name in drafts) values[field.name] = drafts[field.name];
    }
    if (!Object.keys(values).length) return;
    save.mutate(values, {
      onSuccess: () =>
        setDrafts((d) => {
          const next = { ...d };
          for (const key of Object.keys(values)) delete next[key];
          return next;
        }),
    });
  };

  const testProvider = (provider: string) =>
    test.mutate(provider, {
      onSuccess: (result) =>
        setTestResult((r) => ({
          ...r,
          [provider]: result.ok ? `✓ ${result.voices} voices` : `✗ ${result.error}`,
        })),
    });

  return (
    <Card as="section">
      <CardHeader className="mb-4" title={t(`${kind}Providers`)} description={t(`${kind}ProvidersHint`)} />
      {save.error && <p className="field-error mb-3">{errorMessage(save.error, t("error"))}</p>}
      <div className="flex flex-col gap-5">
        {integrations
          ?.filter((i) => i.kind === kind)
          .map((integration) => (
            <div key={integration.provider} className="rounded-lg border border-gray-200 p-4 dark:border-line">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-medium capitalize">{integration.provider}</span>
                <span className={integration.configured ? "text-xs text-emerald-600" : "text-xs text-gray-400"}>
                  {integration.configured ? "configured" : "not configured"}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {integration.fields.map((field) => (
                  // A row from sm up: the label in a column of its own.
                  <Field
                    key={field.name}
                    id={field.name}
                    className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2"
                    labelClassName="mb-0 text-xs font-normal text-gray-500 sm:w-44 sm:shrink-0 dark:text-gray-500"
                    label={
                      <>
                        {FIELD_LABELS[field.name] ?? field.name}
                        {field.source !== "unset" && <span className="ms-1 text-gray-400">({field.source})</span>}
                      </>
                    }
                  >
                    <Input
                      className="sm:flex-1"
                      type="password"
                      autoComplete="off"
                      placeholder={field.masked || "—"}
                      value={drafts[field.name] ?? ""}
                      onChange={(e) => setDrafts((d) => ({ ...d, [field.name]: e.target.value }))}
                    />
                  </Field>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="xs" onClick={() => saveProvider(integration)}>
                  {t("save")}
                </Button>
                <Button variant="secondary" size="xs" onClick={() => testProvider(integration.provider)}>
                  {t("test")}
                </Button>
                {testResult[integration.provider] && (
                  <span className="text-xs text-gray-500">{testResult[integration.provider]}</span>
                )}
              </div>
            </div>
          ))}
      </div>
    </Card>
  );
}
