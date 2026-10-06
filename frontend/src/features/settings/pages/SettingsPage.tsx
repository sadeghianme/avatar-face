import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Select } from "@/components/ui/Select";
import { useRenameOrg, useUsage } from "@/features/settings/api";
import { AiSwitchCard } from "@/features/settings/components/AiSwitchCard";
import { ProvidersCard } from "@/features/settings/components/ProvidersCard";
import { useT } from "@/i18n";
import { useOrg } from "@/providers/org";
import { useTheme } from "@/providers/theme";

export function SettingsPage() {
  const { t, i18n } = useT();
  const { current } = useOrg();
  const { theme, toggle } = useTheme();
  const orgId = current?.id;
  const [orgName, setOrgName] = useState<string | null>(null);
  const isOwner = current?.role === "owner";
  const { data: usage } = useUsage(orgId);
  const rename = useRenameOrg(orgId);

  const renameOrg = () => {
    if (!orgName?.trim() || !orgId) return;
    rename.mutate(orgName.trim(), { onSuccess: () => setOrgName(null) });
  };

  const pct = usage ? Math.min(100, (usage.chars_used / usage.char_limit) * 100) : 0;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t("settings")}</h1>

      {/* Org rename */}
      <Card as="section">
        <CardHeader className="mb-3" title={t("orgSettings")} />
        <div className="flex gap-2">
          <Input
            aria-label={t("orgName")}
            className="flex-1"
            value={orgName ?? current?.name ?? ""}
            onChange={(e) => setOrgName(e.target.value)}
            disabled={!isOwner && current?.role !== "admin"}
          />
          <Button disabled={orgName === null} onClick={renameOrg}>
            {t("save")}
          </Button>
        </div>
      </Card>

      {current && <AiSwitchCard org={current} />}

      {/* Usage */}
      <Card as="section">
        <CardHeader className="mb-3" title={t("usage")} />
        <ProgressBar
          value={pct}
          label={t("usage")}
          className="mb-2"
          barClassName={pct > 90 ? "bg-red-500" : undefined}
        />
        <p className="text-sm text-gray-500">
          {t("charsUsed", {
            used: usage?.chars_used?.toLocaleString() ?? "0",
            limit: usage?.char_limit?.toLocaleString() ?? "—",
          })}
        </p>
        {usage && (usage.image_limit !== undefined || usage.vision_points_limit !== undefined) && (
          <ul className="mt-2 space-y-0.5 text-sm text-gray-500">
            {usage.image_limit !== undefined && (
              <li>{t("usageAiImages", { used: usage.images_generated ?? 0, limit: usage.image_limit })}</li>
            )}
            {usage.vision_points_limit !== undefined && (
              <li>{t("usageAiPoints", { used: usage.vision_points ?? 0, limit: usage.vision_points_limit })}</li>
            )}
          </ul>
        )}
        {usage && usage.by_provider.length > 0 && (
          <ul className="mt-3 text-xs text-gray-400">
            {usage.by_provider.map((row) => (
              <li key={row.provider}>
                {row.provider}: {row.syntheses}× · {row.chars.toLocaleString()} chars
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Appearance */}
      <Card as="section" className="flex flex-wrap items-center gap-6">
        <div>
          <h2 className="mb-2 font-medium">{t("theme")}</h2>
          <Button variant="secondary" icon={theme === "dark" ? "sun" : "moon"} onClick={toggle}>
            {theme === "dark" ? t("light") : t("dark")}
          </Button>
        </div>
        <div>
          <h2 className="mb-2 font-medium">{t("language")}</h2>
          <Select
            aria-label={t("language")}
            className="w-auto"
            value={i18n.language}
            onChange={(e) => void i18n.changeLanguage(e.target.value)}
          >
            <option value="en">English</option>
            <option value="fr">Français</option>
          </Select>
        </div>
      </Card>

      {isOwner && orgId && <ProvidersCard orgId={orgId} kind="voice" />}
      {isOwner && orgId && <ProvidersCard orgId={orgId} kind="image" />}
      {isOwner && orgId && <ProvidersCard orgId={orgId} kind="model" />}
    </div>
  );
}
