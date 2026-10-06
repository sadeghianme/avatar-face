import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useAvatar } from "@/features/avatars/api";
import { FRESH_ENTRY } from "@/features/avatars/wizard";
import { cx } from "@/lib/cx";
import type { Avatar } from "@/lib/types";

/** A card that is a link: it lifts on hover, rings on keyboard focus. */
const LINK_CARD = cx(
  "group overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm",
  "transition-[border-color,box-shadow,transform] duration-200 motion-reduce:transform-none motion-reduce:transition-none",
  "hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-lg hover:shadow-gray-900/[0.07]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
  "dark:border-line dark:bg-panel dark:hover:border-gray-600 dark:hover:shadow-black/20 dark:focus-visible:ring-offset-ink"
);

/** The empty place at the end of the grid that starts a new avatar. */
const CREATE_CARD = cx(
  "group grid min-h-[300px] place-items-center rounded-2xl border border-dashed border-gray-300 bg-gray-50/60 p-8 text-center",
  "transition-colors hover:border-brand-400 hover:bg-brand-50/50",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
  "dark:border-gray-700 dark:bg-white/[0.025] dark:hover:border-brand-500/60 dark:hover:bg-brand-500/[0.05] dark:focus-visible:ring-offset-ink"
);

/**
 * Behind a thumbnail: a warm glow on grey (raised in dark). It used to be
 * one arbitrary background, the gradient and the grey together, which
 * Tailwind wrote as an invalid background-color, so it never showed; the
 * colour and the image are two classes now.
 */
const THUMB_BACKDROP = cx(
  "bg-gray-100 bg-[image:radial-gradient(circle_at_50%_25%,rgba(249,115,22,0.14),transparent_58%)]",
  "dark:bg-raised dark:bg-[image:radial-gradient(circle_at_50%_25%,rgba(249,115,22,0.16),transparent_58%)]"
);

export function AvatarCard({ avatar, orgId, locale }: { avatar: Avatar; orgId: string; locale: string }) {
  const { t } = useTranslation();
  const createdAt = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(avatar.created_at));

  return (
    <Link to={`/avatars/${avatar.id}`} className={LINK_CARD} aria-label={t("openAvatarNamed", { name: avatar.name })}>
      <AvatarThumb avatar={avatar} orgId={orgId} />
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold text-gray-950 dark:text-white">{avatar.name}</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {avatar.kind === "model3d" ? t("avatarKind3D") : t("avatarKindPhoto")} ·{" "}
              {t("createdOn", { date: createdAt })}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <StatusBadge status={avatar.status} />
            {/* Ready is not the same as live: a first build that needs its
                points checked waits for Publish, and embeds show nothing. */}
            {avatar.status === "ready" && !avatar.published && <Badge tone="warning">{t("notLive")}</Badge>}
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3 text-sm dark:border-white/[0.07]">
          <span className="font-medium text-gray-600 transition-colors group-hover:text-brand-600 dark:text-gray-300 dark:group-hover:text-brand-400">
            {t("openAvatar")}
          </span>
          <Icon
            name="arrow"
            className={cx(
              "h-4 w-4 text-gray-400 transition-transform duration-200 motion-reduce:transition-none",
              "group-hover:translate-x-0.5 group-hover:text-brand-500 rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
            )}
          />
        </div>
      </div>
    </Link>
  );
}

function AvatarThumb({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  const { t } = useTranslation();
  // The list carries no signed URLs: the thumbnail comes with the detail.
  const { data } = useAvatar(orgId, avatar.id, { enabled: avatar.status === "ready", staleTime: 60_000 });

  return (
    <div className={cx("relative flex aspect-[4/3] items-center justify-center overflow-hidden", THUMB_BACKDROP)}>
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
            <Icon name={avatar.kind === "model3d" ? "cube" : "faces"} className="h-6 w-6" strokeWidth={1.4} />
          </span>
          <span className="mt-3 block text-xs font-medium">
            {avatar.status === "ready" ? t("loadingPreview") : t(`status.${avatar.status}`)}
          </span>
        </div>
      )}
    </div>
  );
}

/** A fresh start: every step of the wizard at its default (wizard.FRESH_ENTRY). */
export function CreateAvatarCard() {
  const { t } = useTranslation();
  return (
    <Link to="/avatars/new" state={FRESH_ENTRY} className={CREATE_CARD}>
      <div>
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white text-brand-600 shadow-sm transition-transform duration-200 group-hover:scale-105 motion-reduce:transition-none dark:bg-white/[0.07] dark:text-brand-300 dark:shadow-none">
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

/** A card's shape while the list loads. */
export function SkeletonCard() {
  return (
    <Card padding="none" className="overflow-hidden">
      <div className="aspect-[4/3] animate-pulse bg-gray-100 dark:bg-white/[0.06]" />
      <div className="space-y-3 p-4">
        <div className="h-4 w-2/3 animate-pulse rounded bg-gray-100 dark:bg-white/[0.06]" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-gray-100 dark:bg-white/[0.06]" />
      </div>
    </Card>
  );
}
