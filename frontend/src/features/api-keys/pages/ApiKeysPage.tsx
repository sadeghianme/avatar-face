import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { StackCell, StackRow, StackTable, TableAction } from "@/components/ui/Table";
import { type CreatedKey, useApiKeys, useCreateApiKey, useRevokeApiKey } from "@/features/api-keys/api";
import { errorMessage } from "@/lib/errorMessage";
import { useOrg } from "@/providers/org";

export function ApiKeysPage() {
  const { t } = useTranslation();
  const { current } = useOrg();
  const orgId = current?.id;
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [revealed, setRevealed] = useState<CreatedKey | null>(null);
  const canManage = current?.role === "owner" || current?.role === "admin";
  const { data: keys } = useApiKeys(orgId, canManage);
  const create = useCreateApiKey(orgId);
  const revoke = useRevokeApiKey(orgId);

  const createKey = () =>
    create.mutate(
      {
        name: name.trim() || "Widget key",
        allowed_domains: domains
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
      },
      {
        onSuccess: (created) => {
          setRevealed(created);
          setName("");
          setDomains("");
        },
      }
    );

  if (!canManage) {
    return (
      <p className="text-gray-500">
        {t("apiKeys")}: {t(`roles.${current?.role ?? "member"}`)} ⛔
      </p>
    );
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">{t("apiKeys")}</h1>

      <Card
        as="form"
        className="mb-6 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          createKey();
        }}
      >
        <Field id="key-name" label={t("keyName")} className="min-w-40 flex-1">
          <Input placeholder="Production widget" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id="key-domains" label={t("allowedDomains")} className="min-w-56 flex-[2]">
          <Input
            placeholder="example.com, *.example.org"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
          />
        </Field>
        <Button type="submit">{t("createApiKey")}</Button>
      </Card>
      {create.error && <p className="field-error mb-4">{errorMessage(create.error, t("error"))}</p>}

      {revealed && (
        <Card tone="success" className="mb-6">
          {/* Reveal-once: the plaintext only exists in this response. */}
          <p className="mb-2 text-sm font-medium text-emerald-800 dark:text-emerald-200">{t("keyCreatedOnce")}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-white px-3 py-2 text-sm dark:bg-panel">
              {revealed.plaintext}
            </code>
            <CopyButton text={revealed.plaintext} label={t("copy")} copiedLabel={t("copied")} />
            <Button variant="secondary" aria-label={t("close")} onClick={() => setRevealed(null)}>
              ✕
            </Button>
          </div>
        </Card>
      )}

      <Card padding="none">
        <StackTable>
          {keys?.map((key) => (
            <StackRow key={key.id} className={key.revoked_at ? "opacity-50" : undefined}>
              <StackCell kind="lead">
                <div className="font-medium">{key.name}</div>
                <code className="text-xs text-gray-400">{key.prefix}…</code>
              </StackCell>
              <StackCell className="break-words text-xs text-gray-500 max-sm:w-full">
                {key.allowed_domains || "any origin"}
              </StackCell>
              <StackCell kind="end">
                {!key.revoked_at && <TableAction onClick={() => revoke.mutate(key.id)}>{t("revoke")}</TableAction>}
              </StackCell>
            </StackRow>
          ))}
        </StackTable>
      </Card>
    </div>
  );
}
