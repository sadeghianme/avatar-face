import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { api } from "../lib/api";
import { useOrg } from "../lib/org";
import type { Avatar } from "../lib/types";
import { StatusBadge } from "../components/StatusBadge";

function SkeletonCard() {
  return (
    <div className="card animate-pulse">
      <div className="mb-3 aspect-square rounded-lg bg-gray-200 dark:bg-gray-700" />
      <div className="h-4 w-2/3 rounded bg-gray-200 dark:bg-gray-700" />
    </div>
  );
}

export function AvatarsPage() {
  const { t } = useTranslation();
  const { current } = useOrg();
  const { data: avatars, isLoading } = useQuery({
    queryKey: ["avatars", current?.id],
    queryFn: () => api.get<Avatar[]>(`/orgs/${current!.id}/avatars`),
    enabled: Boolean(current),
    refetchInterval: (query) =>
      query.state.data?.some((a) => a.status === "pending" || a.status === "processing")
        ? 2000
        : false,
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("avatars")}</h1>
        <Link to="/avatars/new" className="btn-primary">
          ＋ {t("newAvatar")}
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {isLoading || !current
          ? Array.from({ length: 4 }, (_, i) => <SkeletonCard key={i} />)
          : avatars?.map((avatar) => (
              <Link
                key={avatar.id}
                to={`/avatars/${avatar.id}`}
                className="card transition-shadow hover:shadow-md"
              >
                <AvatarThumb avatar={avatar} orgId={current.id} />
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{avatar.name}</span>
                  <StatusBadge status={avatar.status} />
                </div>
              </Link>
            ))}
      </div>
      {!isLoading && avatars?.length === 0 && (
        <p className="mt-12 text-center text-gray-500">
          {t("uploadPhoto")} → <Link className="text-brand-600" to="/avatars/new">{t("newAvatar")}</Link>
        </p>
      )}
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
    <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-gray-100 dark:bg-gray-700">
      {data?.thumbnail_url ? (
        <img src={data.thumbnail_url} alt={avatar.name} className="h-full w-full object-cover" />
      ) : (
        <span className="text-4xl">🎭</span>
      )}
    </div>
  );
}
