import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { StatusBadge } from "../components/StatusBadge";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useOrg } from "../lib/org";
import type { Avatar, Usage } from "../lib/types";

function SkeletonCard() {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-white/10">
      <div className="aspect-square animate-pulse bg-gray-200 dark:bg-white/10" />
      <div className="p-3">
        <div className="h-4 w-2/3 animate-pulse rounded bg-gray-200 dark:bg-white/10" />
      </div>
    </div>
  );
}

/** A number worth glancing at, not a chart. */
function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone: "brand" | "emerald" | "amber";
}) {
  const tones = {
    brand: "from-brand-500/15 to-brand-500/5 text-brand-600 dark:text-brand-300",
    emerald: "from-emerald-500/15 to-emerald-500/5 text-emerald-600 dark:text-emerald-300",
    amber: "from-amber-500/15 to-amber-500/5 text-amber-600 dark:text-amber-300",
  };
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.03]">
      <div
        className={`inline-flex rounded-lg bg-gradient-to-br px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
      >
        {label}
      </div>
      <p className="mt-2 text-2xl font-bold tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}

export function AvatarsPage() {
  const { t } = useTranslation();
  const { current } = useOrg();
  const { user } = useAuth();

  const { data: avatars, isLoading } = useQuery({
    queryKey: ["avatars", current?.id],
    queryFn: () => api.get<Avatar[]>(`/orgs/${current!.id}/avatars`),
    enabled: Boolean(current),
    refetchInterval: (query) =>
      query.state.data?.some((a) => a.status === "pending" || a.status === "processing")
        ? 2000
        : false,
  });

  const { data: usage } = useQuery({
    queryKey: ["usage", current?.id],
    queryFn: () => api.get<Usage>(`/orgs/${current!.id}/usage`),
    enabled: Boolean(current),
    staleTime: 60_000,
  });

  const ready = avatars?.filter((a) => a.status === "ready").length ?? 0;
  const working =
    avatars?.filter((a) => a.status === "pending" || a.status === "processing").length ?? 0;
  const usedPct = usage?.char_limit
    ? Math.min(100, (usage.chars_used / usage.char_limit) * 100)
    : 0;

  return (
    <div className="space-y-8">
      {/* ---- greeting ---- */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 via-violet-600 to-fuchsia-600 p-7 text-white sm:p-9">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(45%_60%_at_15%_10%,rgba(255,255,255,0.25),transparent),radial-gradient(40%_50%_at_90%_90%,rgba(255,255,255,0.14),transparent)]"
        />
        <div className="relative flex flex-wrap items-end justify-between gap-5">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              {t("dashGreeting", { name: user?.display_name || user?.username || "" })}
            </h1>
            <p className="mt-2 max-w-md text-sm text-white/80">{t("dashSubtitle")}</p>
          </div>
          <Link
            to="/avatars/new"
            className="btn inline-flex bg-white px-5 py-2.5 font-semibold text-brand-700 shadow-lg hover:bg-white/90"
          >
            ＋ {t("newAvatar")}
          </Link>
        </div>
      </div>

      {/* ---- stats ---- */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label={t("statReady")} value={ready} hint={t("statReadyHint")} tone="emerald" />
        <Stat
          label={t("statProcessing")}
          value={working}
          hint={working ? t("statProcessingHint") : t("statAllDone")}
          tone="amber"
        />
        <Stat
          label={t("statUsage")}
          value={usage ? `${Math.round(usedPct)}%` : "—"}
          hint={
            usage
              ? t("charsUsed", {
                  used: usage.chars_used.toLocaleString(),
                  limit: usage.char_limit.toLocaleString(),
                })
              : undefined
          }
          tone="brand"
        />
      </div>

      {/* ---- avatars ---- */}
      <div>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">{t("avatars")}</h2>
          {avatars && avatars.length > 0 && (
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {t("avatarCount", { count: avatars.length })}
            </span>
          )}
        </div>

        {isLoading || !current ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : avatars && avatars.length > 0 ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {avatars.map((avatar) => (
              <Link
                key={avatar.id}
                to={`/avatars/${avatar.id}`}
                className="group overflow-hidden rounded-2xl border border-gray-200 bg-white transition
                  hover:-translate-y-1 hover:border-brand-300 hover:shadow-xl
                  dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-brand-500/40"
              >
                <AvatarThumb avatar={avatar} orgId={current.id} />
                <div className="flex items-center justify-between gap-2 p-3">
                  <span className="truncate text-sm font-medium">{avatar.name}</span>
                  <StatusBadge status={avatar.status} />
                </div>
              </Link>
            ))}

            {/* The add tile sits with the others, so creating one is never a hunt. */}
            <Link
              to="/avatars/new"
              className="grid place-items-center rounded-2xl border-2 border-dashed border-gray-300
                p-6 text-center text-sm text-gray-500 transition hover:border-brand-400
                hover:text-brand-600 dark:border-white/15 dark:text-gray-400 dark:hover:border-brand-500/50"
            >
              <span>
                <span className="block text-2xl">＋</span>
                <span className="mt-1 block">{t("newAvatar")}</span>
              </span>
            </Link>
          </div>
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}

/** First run. A blank grid tells a new user nothing about what to do next. */
function EmptyState() {
  const { t } = useTranslation();
  const steps = ["stepUploadTitle", "stepTuneTitle", "stepEmbedTitle"];
  return (
    <div className="rounded-3xl border border-dashed border-gray-300 p-10 text-center dark:border-white/15">
      <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-brand-500/20 to-fuchsia-500/20 text-3xl">
        🎭
      </div>
      <h3 className="mt-5 text-lg font-semibold">{t("emptyTitle")}</h3>
      <p className="mx-auto mt-2 max-w-sm text-sm text-gray-500 dark:text-gray-400">
        {t("emptyBody")}
      </p>
      <ol className="mx-auto mt-6 flex max-w-lg flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs text-gray-500 dark:text-gray-400">
        {steps.map((k, i) => (
          <li key={k} className="flex items-center gap-2">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-brand-600 text-[10px] font-bold text-white">
              {i + 1}
            </span>
            {t(k)}
            {i < steps.length - 1 && <span className="ms-1 text-gray-300">→</span>}
          </li>
        ))}
      </ol>
      <Link to="/avatars/new" className="btn-primary mt-7 px-6 py-2.5">
        ＋ {t("newAvatar")}
      </Link>
    </div>
  );
}

function AvatarThumb({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  // The list endpoint is light; thumbnails come from the detail endpoint.
  const { data } = useQuery({
    queryKey: ["avatar", orgId, avatar.id],
    queryFn: () => api.get<Avatar>(`/orgs/${orgId}/avatars/${avatar.id}`),
    enabled: avatar.status === "ready",
    staleTime: 60_000,
  });
  return (
    <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-gradient-to-br from-gray-100 to-gray-200 dark:from-white/[0.06] dark:to-white/[0.02]">
      {data?.thumbnail_url ? (
        <img
          src={data.thumbnail_url}
          alt={avatar.name}
          className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
        />
      ) : (
        <span className="text-4xl opacity-60">🎭</span>
      )}
    </div>
  );
}
