import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Icon } from "../components/Icon";
import { StatusBadge } from "../components/StatusBadge";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useOrg } from "../lib/org";
import type { Avatar, Usage } from "../lib/types";

function SkeletonCard() {
  return (
    <div>
      <div className="aspect-square animate-pulse rounded-2xl bg-black/[0.05] dark:bg-white/[0.06]" />
      <div className="mt-2.5 h-3.5 w-2/3 animate-pulse rounded bg-black/[0.05] dark:bg-white/[0.06]" />
    </div>
  );
}

/**
 * A figure, not a card.
 *
 * These were four bordered boxes with progress rings and coloured pills. The
 * chrome outweighed the content — three of the four numbers are small
 * integers. A row of plain figures divided by hairlines reads faster and
 * stops the page opening with a wall of boxes.
 */
function Figure({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="px-5 py-4 first:ps-0 sm:px-6">
      <p className="text-[12.5px] text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-1 text-[26px] font-semibold leading-none tracking-[-0.02em]">{value}</p>
      {hint && <p className="mt-1.5 text-[12px] text-gray-400">{hint}</p>}
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
  const total = avatars?.length ?? 0;
  const usedPct = usage?.char_limit
    ? Math.min(100, (usage.chars_used / usage.char_limit) * 100)
    : 0;

  return (
    <div>
      {/* Large, tight, quiet. The page says what it is once and then gets
          out of the way — a gradient banner repeating the product name is
          decoration, not information. */}
      <h1 className="text-[32px] font-semibold tracking-[-0.03em] sm:text-[38px]">
        {t("dashGreeting", { name: user?.display_name || user?.username || "" })}
      </h1>
      <p className="mt-1.5 text-[15px] text-gray-500 dark:text-gray-400">{t("dashSubtitle")}</p>

      <div className="mt-8 flex flex-wrap divide-x divide-black/[0.07] border-y border-black/[0.07] dark:divide-white/[0.07] dark:border-white/[0.07]">
        <Figure label={t("statTotal")} value={total} />
        <Figure label={t("statReady")} value={ready} />
        <Figure label={t("statProcessing")} value={working} />
        <Figure
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
        />
      </div>

      <div className="mt-10">
        <div className="mb-4 flex items-baseline justify-between">
          <div className="flex items-baseline gap-3">
            <h2 className="text-[19px] font-semibold tracking-[-0.02em]">{t("avatars")}</h2>
            {avatars && avatars.length > 0 && (
              <span className="text-[13px] text-gray-400">
                {t("avatarCount", { count: avatars.length })}
              </span>
            )}
          </div>
          {/* Creating an avatar belongs beside the avatars, not in the app
              chrome: in the header it sat on every page including the ones
              where it means nothing. */}
          <Link
            to="/avatars/new"
            className="inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-85 dark:bg-white dark:text-gray-900"
          >
            <Icon name="plus" className="h-4 w-4" strokeWidth={2} />
            {t("newAvatar")}
          </Link>
        </div>

        {isLoading || !current ? (
          <div className="grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : avatars && avatars.length > 0 ? (
          <div className="grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-3 lg:grid-cols-4">
            {avatars.map((avatar) => (
              <Link key={avatar.id} to={`/avatars/${avatar.id}`} className="group">
                {/* The image IS the card. A border around a photograph adds
                    nothing and turns a grid into a spreadsheet. */}
                <AvatarThumb avatar={avatar} orgId={current.id} />
                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <span className="truncate text-[13.5px] font-medium">{avatar.name}</span>
                  <StatusBadge status={avatar.status} />
                </div>
              </Link>
            ))}

            <Link
              to="/avatars/new"
              className="group flex aspect-square items-center justify-center rounded-2xl border border-dashed border-black/[0.12] text-gray-400 transition-colors hover:border-brand-400 hover:text-brand-500 dark:border-white/[0.14]"
            >
              <Icon name="plus" className="h-7 w-7" strokeWidth={1.4} />
            </Link>
          </div>
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="py-20 text-center">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-black/[0.04] text-gray-400 dark:bg-white/[0.06]">
        <Icon name="faces" className="h-7 w-7" strokeWidth={1.3} />
      </div>
      <h3 className="mt-5 text-[19px] font-semibold tracking-[-0.02em]">{t("emptyTitle")}</h3>
      <p className="mx-auto mt-2 max-w-xs text-[14px] leading-relaxed text-gray-500 dark:text-gray-400">
        {t("emptyBody")}
      </p>
      <Link
        to="/avatars/new"
        className="mt-7 inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-5 py-2.5 text-[14px] font-medium text-white transition-opacity hover:opacity-85 dark:bg-white dark:text-gray-900"
      >
        <Icon name="plus" className="h-4 w-4" strokeWidth={2} />
        {t("newAvatar")}
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
    <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-2xl bg-black/[0.04] transition-shadow duration-300 group-hover:shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:bg-white/[0.06]">
      {data?.thumbnail_url ? (
        <img
          src={data.thumbnail_url}
          alt={avatar.name}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
        />
      ) : (
        <Icon name="faces" className="h-8 w-8 text-gray-300 dark:text-gray-600" strokeWidth={1.2} />
      )}
    </div>
  );
}
