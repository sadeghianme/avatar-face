import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { api } from "../lib/api";
import type { Avatar } from "../lib/types";

/**
 * Generate an avatar image, from a photo you already have or from nothing.
 *
 * Candidates are shown with the rejections alongside them. Hiding the failures
 * and silently retrying would be smoother and much less useful: "the head is
 * turned away" tells you what to change about the source, while a spinner that
 * eventually gives up tells you nothing.
 */

const STYLES = ["photoreal", "illustrated", "anime", "render3d"] as const;

interface Candidate {
  /** Which image model made this one — gemini, openai or qwen. */
  provider?: string;
  key: string;
  url: string;
  face_fraction: number;
}

interface GenerateResult {
  candidates: Candidate[];
  rejected: string[];
  attempts: number;
}

export function GeneratePanel({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [style, setStyle] = useState<string>("illustrated");
  const [sourceId, setSourceId] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);

  // Only ready photos can be a source; a 3D avatar has no photograph, and a
  // pending one has nothing stored yet.
  const { data: avatars } = useQuery({
    queryKey: ["avatars", orgId],
    queryFn: () => api.get<Avatar[]>(`/orgs/${orgId}/avatars`),
  });
  const sources = (avatars ?? []).filter((a) => a.kind === "photo" && a.status === "ready");

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await api.post<GenerateResult>(`/orgs/${orgId}/avatars/generate`, {
          style,
          source_avatar_id: sourceId || null,
          count: 2,
          note,
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const use = async (candidate: Candidate) => {
    setCreating(candidate.key);
    setError(null);
    try {
      const avatar = await api.post<Avatar>(`/orgs/${orgId}/avatars/from-candidate`, {
        name: `${style} avatar`,
        key: candidate.key,
      });
      navigate(`/avatars/${avatar.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(null);
    }
  };

  return (
    <div>
      <div className="flex flex-col gap-4">
        <div>
          <label className="label mb-1.5 block">{t("genStyle")}</label>
          <div className="flex flex-wrap gap-2">
            {STYLES.map((s) => (
              <button
                key={s}
                onClick={() => setStyle(s)}
                className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                  style === s
                    ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                    : "border border-black/10 text-gray-600 hover:bg-black/5 dark:border-white/15 dark:text-gray-300 dark:hover:bg-white/10"
                }`}
              >
                {t(`genStyle_${s}`)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label mb-1.5 block" htmlFor="gen-source">
            {t("genSource")}
          </label>
          <select
            id="gen-source"
            className="input"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
          >
            <option value="">{t("genFromScratch")}</option>
            {sources.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[12.5px] text-gray-500 dark:text-gray-400">
            {sourceId ? t("genSourceHint") : t("genScratchHint")}
          </p>
        </div>

        <div>
          <label className="label mb-1.5 block" htmlFor="gen-note">
            {t("genNote")}
          </label>
          <input
            id="gen-note"
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("genNotePlaceholder")}
          />
        </div>

        <div className="flex items-center gap-3">
          <button className="btn-primary" onClick={() => void run()} disabled={busy}>
            {busy ? (
              <Spinner className="me-1.5 inline h-4 w-4" />
            ) : (
              <Icon name="cube" className="me-1.5 inline h-4 w-4" />
            )}
            {busy ? t("genWorking") : t("generate")}
          </button>
          <span className="text-[12.5px] text-gray-500 dark:text-gray-400">{t("genCost")}</span>
        </div>

        {error && <p className="field-error">{error}</p>}
      </div>

      {busy && (
        <div className="mt-6">
          <h3 className="mb-3 text-[15px] font-semibold">{t("genWorking")}</h3>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="grid aspect-square animate-pulse place-items-center rounded-xl bg-black/[0.05] text-gray-400 dark:bg-white/[0.06]"
              >
                <Spinner className="h-6 w-6" />
              </div>
            ))}
          </div>
        </div>
      )}

      {!busy && result && (
        <div className="mt-6">
          {result.candidates.length > 0 && (
            <>
              <h3 className="mb-3 text-[15px] font-semibold">{t("genPick")}</h3>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {result.candidates.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => void use(c)}
                    disabled={creating !== null}
                    className="group text-start disabled:opacity-50"
                  >
                    <div className="overflow-hidden rounded-xl border border-black/[0.08] transition-shadow group-hover:shadow-lg dark:border-white/[0.1]">
                      <div className="relative">
                        <img src={c.url} alt="" className="block w-full" />
                        {c.provider && (
                          <span className="absolute end-1.5 top-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-white">
                            {c.provider}
                          </span>
                        )}
                      </div>
                      {creating === c.key && (
                        <div className="grid place-items-center bg-black/60 p-4 text-white">
                          <Spinner className="h-5 w-5" />
                        </div>
                      )}
                    </div>
                    <p className="mt-1.5 text-[12.5px] text-gray-500">
                      {creating === c.key ? t("loading") : t("genUseThis")}
                    </p>
                  </button>
                ))}
              </div>
            </>
          )}

          {result.candidates.length === 0 && (
            <p className="field-error">{t("genNoneUsable")}</p>
          )}

          {result.rejected.length > 0 && (
            <div className="mt-4 rounded-xl bg-black/[0.03] p-3 dark:bg-white/[0.04]">
              <p className="text-[12.5px] font-medium text-gray-600 dark:text-gray-300">
                {t("genRejected", { count: result.rejected.length, attempts: result.attempts })}
              </p>
              <ul className="mt-1 list-inside list-disc text-[12.5px] text-gray-500 dark:text-gray-400">
                {result.rejected.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
