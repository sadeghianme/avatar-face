import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { DraftCreations } from "@/features/avatars/components/create/DraftCreations";
import { AvatarCard, CreateAvatarCard, SkeletonCard } from "@/features/avatars/components/library/AvatarCards";
import { StatCard } from "@/features/avatars/components/library/StatCard";
import { FRESH_ENTRY } from "@/features/avatars/wizard";
import { api } from "@/lib/api";
import { cx } from "@/lib/cx";
import type { Avatar, Usage } from "@/lib/types";
import { useOrg } from "@/providers/org";

type AvatarFilter = "all" | "ready" | "processing" | "failed";

/** The New avatar action's plus, a touch bolder than an icon in words. */
const PLUS = <Icon name="plus" className="h-4 w-4" strokeWidth={2} />;

/** One line of what the AI made this month, on a brand tint. */
const AI_REPORT = cx(
  "mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl px-4 py-3 text-xs",
  "border border-brand-100 bg-brand-50/60 dark:border-brand-500/20 dark:bg-brand-500/[0.06]"
);

export function AvatarsPage() {
  const { t, i18n } = useTranslation();
  const { current } = useOrg();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AvatarFilter>("all");

  const { data: avatars, isLoading } = useQuery({
    queryKey: ["avatars", current?.id],
    queryFn: () => api.get<Avatar[]>(`/orgs/${current!.id}/avatars`),
    enabled: Boolean(current),
    refetchInterval: (result) =>
      result.state.data?.some((avatar) => avatar.status === "pending" || avatar.status === "processing") ? 2000 : false,
  });

  const { data: usage } = useQuery({
    queryKey: ["usage", current?.id],
    queryFn: () => api.get<Usage>(`/orgs/${current!.id}/usage`),
    enabled: Boolean(current),
    staleTime: 60_000,
  });

  const ready = avatars?.filter((avatar) => avatar.status === "ready").length ?? 0;
  const working =
    avatars?.filter((avatar) => avatar.status === "pending" || avatar.status === "processing").length ?? 0;
  const total = avatars?.length ?? 0;
  const usedPct = usage?.char_limit ? Math.min(100, (usage.chars_used / usage.char_limit) * 100) : 0;

  const filteredAvatars = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(i18n.language);
    return (avatars ?? []).filter((avatar) => {
      const matchesSearch = !normalizedQuery || avatar.name.toLocaleLowerCase(i18n.language).includes(normalizedQuery);
      const matchesFilter =
        filter === "all" || avatar.status === filter || (filter === "processing" && avatar.status === "pending");
      return matchesSearch && matchesFilter;
    });
  }, [avatars, filter, i18n.language, query]);

  const filters: { value: AvatarFilter; label: string; count: number }[] = [
    { value: "all", label: t("filterAll"), count: total },
    { value: "ready", label: t("status.ready"), count: ready },
    { value: "processing", label: t("status.processing"), count: working },
    {
      value: "failed",
      label: t("status.failed"),
      count: avatars?.filter((avatar) => avatar.status === "failed").length ?? 0,
    },
  ];

  return (
    <div>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-brand-600 dark:text-brand-400">{t("avatarLibrary")}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.035em] text-gray-950 sm:text-4xl dark:text-white">
            {t("avatars")}
          </h1>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-gray-500 dark:text-gray-400">
            {t("dashSubtitle")}
          </p>
        </div>
        {/* A fresh start: every step of the wizard at its default (wizard.FRESH_ENTRY). */}
        <ButtonLink
          to="/avatars/new"
          state={FRESH_ENTRY}
          size="lg"
          icon={PLUS}
          className="shrink-0 self-start px-5 shadow-sm shadow-brand-600/15"
        >
          {t("newAvatar")}
        </ButtonLink>
      </div>

      <section className="mt-8 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4" aria-label={t("overview")}>
        <StatCard label={t("statTotal")} value={total} hint={t("statTotalHint")} icon="faces" tone="neutral" />
        <StatCard label={t("statReady")} value={ready} hint={t("statReadyHint")} icon="check" tone="success" />
        <StatCard
          label={t("statProcessing")}
          value={working}
          hint={working ? t("statProcessingHint") : t("statAllDone")}
          icon="clock"
          tone="warning"
        />
        <StatCard
          label={t("statUsage")}
          value={usage ? `${Math.round(usedPct)}%` : "—"}
          hint={
            usage
              ? t("charsUsed", {
                  used: usage.chars_used.toLocaleString(i18n.language),
                  limit: usage.char_limit.toLocaleString(i18n.language),
                })
              : t("loading")
          }
          icon="chart"
          tone="brand"
          progress={usage ? usedPct : undefined}
        />
      </section>

      {(usage?.images_generated ?? 0) > 0 || (usage?.vision_points ?? 0) > 0 ? (
        <div className={AI_REPORT}>
          <span className="font-semibold text-gray-900 dark:text-white">{t("aiReportTitle")}</span>
          <span className="text-gray-600 dark:text-gray-300">
            {t("aiReportMade", { count: usage?.avatars_generated ?? 0 })}
          </span>
          <span className="text-gray-600 dark:text-gray-300">
            {t("aiReportAttempts", {
              used: usage?.images_generated ?? 0,
              limit: usage?.image_limit ?? 0,
            })}
          </span>
          <span className="text-gray-600 dark:text-gray-300">
            {t("aiReportCost", { cost: (usage?.image_cost_usd ?? 0).toFixed(2) })}
          </span>
          {usage?.vision_points_limit !== undefined && (
            <span className="text-gray-600 dark:text-gray-300">
              {t("aiReportPoints", { used: usage.vision_points ?? 0, limit: usage.vision_points_limit })}
            </span>
          )}
        </div>
      ) : null}

      {current && <DraftCreations orgId={current.id} />}

      <section className="mt-8" aria-labelledby="avatar-library-heading">
        <Card className="p-4 sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2.5">
                <h2 id="avatar-library-heading" className="text-lg font-semibold tracking-[-0.02em]">
                  {t("yourAvatars")}
                </h2>
                <Badge className="px-2.5 py-1 dark:bg-white/[0.07]">{t("avatarCount", { count: total })}</Badge>
              </div>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("avatarLibraryHint")}</p>
            </div>

            <Field label={t("searchAvatars")} hideLabel className="min-w-0 sm:w-64">
              <Input
                type="search"
                icon="search"
                iconSize="sm"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("searchAvatars")}
                className="min-h-11 text-base sm:text-sm"
              />
            </Field>
          </div>

          <div className="mt-5 flex gap-2 overflow-x-auto border-t border-gray-100 pt-4 dark:border-white/[0.07]">
            {filters.map((item) => (
              <Chip key={item.value} selected={filter === item.value} onClick={() => setFilter(item.value)}>
                {item.label}
                <span className={filter === item.value ? "text-white/70 dark:text-gray-500" : "text-gray-400"}>
                  {item.count}
                </span>
              </Chip>
            ))}
          </div>
        </Card>

        <div className="mt-5">
          {isLoading || !current ? (
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, index) => (
                <SkeletonCard key={index} />
              ))}
            </div>
          ) : avatars && avatars.length > 0 && filteredAvatars.length > 0 ? (
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {filteredAvatars.map((avatar) => (
                <AvatarCard key={avatar.id} avatar={avatar} orgId={current.id} locale={i18n.language} />
              ))}
              {filter === "all" && !query ? <CreateAvatarCard /> : null}
            </div>
          ) : avatars && avatars.length > 0 ? (
            <EmptyState
              icon="search"
              title={t("noAvatarMatches")}
              body={t("noAvatarMatchesBody")}
              action={
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                >
                  {t("clearFilters")}
                </Button>
              }
            />
          ) : (
            <EmptyState
              variant="dashed"
              icon="faces"
              title={t("emptyTitle")}
              body={t("emptyBody")}
              action={
                <ButtonLink to="/avatars/new" state={FRESH_ENTRY} size="lg" icon={PLUS} className="px-5">
                  {t("newAvatar")}
                </ButtonLink>
              }
            />
          )}
        </div>
      </section>
    </div>
  );
}
