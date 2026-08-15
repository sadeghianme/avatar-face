import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "./Icon";
import { api, ApiError } from "../lib/api";
import type { Avatar } from "../lib/types";

/**
 * Publish this avatar as a page anyone with the link can talk to.
 *
 * Off until asked for, and the copy says plainly what "on" means — a link
 * with no password on it spends the owner's speech quota, so nobody should
 * discover that after the fact.
 */
export function SharePanel({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = avatar.share_token ?? null;
  const url = token ? `${window.location.origin}/s/${token}` : "";

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = `/orgs/${orgId}/avatars/${avatar.id}/share`;
      if (token) await api.delete(path);
      else await api.post(path, {});
      await queryClient.invalidateQueries({ queryKey: ["avatar", orgId, avatar.id] });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 font-medium">
            <Icon name="link" className="h-4 w-4 text-gray-400" />
            {t("shareTitle")}
          </h3>
          <p className="mt-1 text-[13px] text-gray-500 dark:text-gray-400">
            {token ? t("shareOnBody") : t("shareOffBody")}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(token)}
          aria-label={t("shareTitle")}
          onClick={() => void toggle()}
          disabled={busy || avatar.status !== "ready"}
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors
            disabled:cursor-not-allowed disabled:opacity-60
            ${token ? "bg-brand-600" : "bg-gray-300 dark:bg-gray-600"}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all
              ${token ? "start-[22px]" : "start-0.5"}`}
          />
        </button>
      </div>

      {token && (
        <div className="mt-3 flex gap-2">
          <input readOnly value={url} onFocus={(e) => e.target.select()} className="input text-xs" />
          <button className="btn-secondary shrink-0" onClick={() => void copy()}>
            {copied ? t("copied") : t("copy")}
          </button>
          <a className="btn-secondary shrink-0" href={url} target="_blank" rel="noreferrer">
            {t("shareOpen")}
          </a>
        </div>
      )}
      {error && <p className="field-error mt-2">{error}</p>}
    </div>
  );
}
