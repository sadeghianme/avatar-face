import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Icon, type IconName } from "@/components/ui/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { api } from "@/lib/api";
import { useOrg } from "@/providers/org";
import type { Avatar, Usage } from "@/lib/types";

type AvatarFilter = "all" | "ready" | "processing" | "failed";

const STAT_TONES = {
  neutral: "bg-gray-100 text-gray-700 dark:bg-white/[0.07] dark:text-gray-200",
  success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  brand: "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300",
};

function StatCard({
  label,
  value,
  hint,
  icon,
  tone,
  progress,
}: {
  label: string;
  value: string | number;
  hint: string;
  icon: IconName;
  tone: keyof typeof STAT_TONES;
  progress?: number;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5 dark:border-line dark:bg-panel dark:shadow-none">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{label}</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums tracking-[-0.04em] text-gray-950 sm:text-3xl dark:text-white">
            {value}
          </p>
        </div>
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl sm:h-10 sm:w-10 ${STAT_TONES[tone]}`}>
          <Icon name={icon} className="h-[18px] w-[18px] sm:h-5 sm:w-5" strokeWidth={1.7} />
        </span>
      </div>
      {progress !== undefined ? (
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-white/[0.07]">
          <div
            className="h-full rounded-full bg-brand-500 transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}
      <p className="mt-3 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{hint}</p>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-line dark:bg-panel dark:shadow-none">
      <div className="aspect-[4/3] animate-pulse bg-gray-100 dark:bg-white/[0.06]" />
      <div className="space-y-3 p-4">
        <div className="h-4 w-2/3 animate-pulse rounded bg-gray-100 dark:bg-white/[0.06]" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-gray-100 dark:bg-white/[0.06]" />
      </div>
    </div>
  );
}

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
      result.state.data?.some(
        (avatar) => avatar.status === "pending" || avatar.status === "processing"
      )
        ? 2000
        : false,
  });

  const { data: usage } = useQuery({
    queryKey: ["usage", current?.id],
    queryFn: () => api.get<Usage>(`/orgs/${current!.id}/usage`),
    enabled: Boolean(current),
    staleTime: 60_000,
  });

  const ready = avatars?.filter((avatar) => avatar.status === "ready").length ?? 0;
  const working =
    avatars?.filter(
      (avatar) => avatar.status === "pending" || avatar.status === "processing"
    ).length ?? 0;
  const total = avatars?.length ?? 0;
  const usedPct = usage?.char_limit
    ? Math.min(100, (usage.chars_used / usage.char_limit) * 100)
    : 0;

  const filteredAvatars = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(i18n.language);
    return (avatars ?? []).filter((avatar) => {
      const matchesSearch =
        !normalizedQuery || avatar.name.toLocaleLowerCase(i18n.language).includes(normalizedQuery);
      const matchesFilter =
        filter === "all" ||
        avatar.status === filter ||
        (filter === "processing" && avatar.status === "pending");
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
        <Link
          to="/avatars/new"
          className="btn-primary min-h-11 shrink-0 self-start px-5 shadow-sm shadow-brand-600/15"
        >
          <Icon name="plus" className="h-4 w-4" strokeWidth={2} />
          {t("newAvatar")}
        </Link>
      </div>

      <section className="mt-8 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4" aria-label={t("overview")}>
        <StatCard
          label={t("statTotal")}
          value={total}
          hint={t("statTotalHint")}
          icon="faces"
          tone="neutral"
        />
        <StatCard
          label={t("statReady")}
          value={ready}
          hint={t("statReadyHint")}
          icon="check"
          tone="success"
        />
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

      {(usage?.images_generated ?? 0) > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-brand-100 bg-brand-50/60 px-4 py-3 text-xs dark:border-brand-500/20 dark:bg-brand-500/[0.06]">
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
        </div>
      ) : null}

      <section className="mt-8" aria-labelledby="avatar-library-heading">
        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5 dark:border-line dark:bg-panel dark:shadow-none">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2.5">
                <h2 id="avatar-library-heading" className="text-lg font-semibold tracking-[-0.02em]">
                  {t("yourAvatars")}
                </h2>
                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600 dark:bg-white/[0.07] dark:text-gray-300">
                  {t("avatarCount", { count: total })}
                </span>
              </div>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("avatarLibraryHint")}</p>
            </div>

            <label className="relative block min-w-0 sm:w-64">
              <span className="sr-only">{t("searchAvatars")}</span>
              <Icon
                name="search"
                className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("searchAvatars")}
                  className="input min-h-11 ps-9 text-base sm:text-sm"
              />
            </label>
          </div>

          <div className="mt-5 flex gap-2 overflow-x-auto border-t border-gray-100 pt-4 dark:border-white/[0.07]">
            {filters.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={filter === item.value}
                onClick={() => setFilter(item.value)}
                className={`inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-panel ${
                  filter === item.value
                    ? "bg-gray-900 text-white dark:bg-white dark:text-gray-950"
                    : "text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-white"
                }`}
              >
                {item.label}
                <span
                  className={
                    filter === item.value ? "text-white/70 dark:text-gray-500" : "text-gray-400"
                  }
                >
                  {item.count}
                </span>
              </button>
            ))}
          </div>
        </div>

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
                <AvatarCard
                  key={avatar.id}
                  avatar={avatar}
                  orgId={current.id}
                  locale={i18n.language}
                />
              ))}
              {filter === "all" && !query ? <CreateAvatarCard /> : null}
            </div>
          ) : avatars && avatars.length > 0 ? (
            <FilteredEmptyState
              onClear={() => {
                setQuery("");
                setFilter("all");
              }}
            />
          ) : (
            <EmptyState />
          )}
        </div>
      </section>
    </div>
  );
}

function AvatarCard({
  avatar,
  orgId,
  locale,
}: {
  avatar: Avatar;
  orgId: string;
  locale: string;
}) {
  const { t } = useTranslation();
  const createdAt = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(avatar.created_at));

  return (
    <Link
      to={`/avatars/${avatar.id}`}
      className="group overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-lg hover:shadow-gray-900/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 motion-reduce:transform-none motion-reduce:transition-none dark:border-line dark:bg-panel dark:hover:border-gray-600 dark:hover:shadow-black/20 dark:focus-visible:ring-offset-ink"
      aria-label={t("openAvatarNamed", { name: avatar.name })}
    >
      <AvatarThumb avatar={avatar} orgId={orgId} />
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold text-gray-950 dark:text-white">
              {avatar.name}
            </h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {avatar.kind === "model3d" ? t("avatarKind3D") : t("avatarKindPhoto")} ·{" "}
              {t("createdOn", { date: createdAt })}
            </p>
          </div>
          <StatusBadge status={avatar.status} />
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3 text-sm dark:border-white/[0.07]">
          <span className="font-medium text-gray-600 transition-colors group-hover:text-brand-600 dark:text-gray-300 dark:group-hover:text-brand-400">
            {t("openAvatar")}
          </span>
          <Icon
            name="arrow"
            className="h-4 w-4 text-gray-400 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-brand-500 motion-reduce:transition-none rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
          />
        </div>
      </div>
    </Link>
  );
}

function AvatarThumb({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["avatar", orgId, avatar.id],
    queryFn: () => api.get<Avatar>(`/orgs/${orgId}/avatars/${avatar.id}`),
    enabled: avatar.status === "ready",
    staleTime: 60_000,
  });

  return (
    <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_50%_25%,rgba(249,115,22,0.14),transparent_58%),#f3f4f6] dark:bg-[radial-gradient(circle_at_50%_25%,rgba(249,115,22,0.16),transparent_58%),#1c1c1c]">
      {data?.thumbnail_url ? (
        <img
          src={data.thumbnail_url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.025] motion-reduce:transition-none"
        />
      ) : (
        <div className="text-center text-gray-400 dark:text-gray-500">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white/80 shadow-sm dark:bg-white/[0.06] dark:shadow-none">
            <Icon
              name={avatar.kind === "model3d" ? "cube" : "faces"}
              className="h-6 w-6"
              strokeWidth={1.4}
            />
          </span>
          <span className="mt-3 block text-xs font-medium">
            {avatar.status === "ready" ? t("loadingPreview") : t(`status.${avatar.status}`)}
          </span>
        </div>
      )}
    </div>
  );
}

function CreateAvatarCard() {
  const { t } = useTranslation();
  return (
    <Link
      to="/avatars/new"
      className="group grid min-h-[300px] place-items-center rounded-2xl border border-dashed border-gray-300 bg-gray-50/60 p-8 text-center transition-colors hover:border-brand-400 hover:bg-brand-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:border-gray-700 dark:bg-white/[0.025] dark:hover:border-brand-500/60 dark:hover:bg-brand-500/[0.05] dark:focus-visible:ring-offset-ink"
    >
      <div>
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white text-brand-600 shadow-sm transition-transform duration-200 group-hover:scale-105 dark:bg-white/[0.07] dark:text-brand-300 dark:shadow-none motion-reduce:transition-none">
          <Icon name="plus" className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <h3 className="mt-4 text-sm font-semibold">{t("newAvatar")}</h3>
        <p className="mx-auto mt-1.5 max-w-[220px] text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          {t("createAvatarHint")}
        </p>
      </div>
    </Link>
  );
}

function FilteredEmptyState({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-2xl border border-gray-200 bg-white px-6 py-16 text-center shadow-sm dark:border-line dark:bg-panel dark:shadow-none">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-gray-100 text-gray-400 dark:bg-white/[0.06]">
        <Icon name="search" className="h-5 w-5" />
      </span>
      <h3 className="mt-4 text-base font-semibold">{t("noAvatarMatches")}</h3>
      <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">{t("noAvatarMatchesBody")}</p>
      <button type="button" className="btn-secondary mt-5 min-h-11 cursor-pointer" onClick={onClear}>
        {t("clearFilters")}
      </button>
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50/50 px-6 py-20 text-center dark:border-gray-700 dark:bg-white/[0.025]">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white text-brand-600 shadow-sm dark:bg-white/[0.07] dark:text-brand-300 dark:shadow-none">
        <Icon name="faces" className="h-7 w-7" strokeWidth={1.4} />
      </span>
      <h3 className="mt-5 text-lg font-semibold tracking-[-0.02em]">{t("emptyTitle")}</h3>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-gray-500 dark:text-gray-400">
        {t("emptyBody")}
      </p>
      <Link to="/avatars/new" className="btn-primary mt-6 min-h-11 px-5">
        <Icon name="plus" className="h-4 w-4" strokeWidth={2} />
        {t("newAvatar")}
      </Link>
    </div>
  );
}
