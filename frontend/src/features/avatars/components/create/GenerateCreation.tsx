import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { rememberCreationName } from "@/features/avatars/components/create/CreationWizard";
import { ADJUST_STYLES, errorText, type AdjustStyle, type Creation } from "@/features/avatars/creation";
import { creationKey, draftsKey } from "@/features/avatars/hooks/useCreation";
import { useConsent } from "@/features/avatars/hooks/useConsent";
import { LINE_ORDER, LINES } from "@/features/avatars/lines";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { api, ApiError } from "@/lib/api";
import { useOrg } from "@/providers/org";
import type { Avatar, FaceType } from "@/lib/types";

/** The API's bound on the description. */
export const MAX_PROMPT = 300;

/**
 * Generate a picture, and carry on in the wizard as for an upload.
 *
 * POST /creations/generate starts a creation whose original the image model
 * makes (a job); the wizard opens on it at once and shows the job, then the
 * same framing, AI adjust, background and points as any photo, so a
 * generated face passes the same confirmation (and, for a person, the same
 * statement) before it is built.
 *
 * Starting from one of the org's photo avatars sends that photo to Google,
 * so it goes through the third-party AI statement first; a description
 * alone sends no picture and needs none. With third-party AI switched off
 * the panel says so instead of offering a button the server would refuse.
 */
export function GenerateCreation({ orgId, name }: { orgId: string; name: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { current } = useOrg();
  const consent = useConsent(orgId);
  const [line, setLine] = useState<FaceType>("human");
  const [style, setStyle] = useState<AdjustStyle>("photoreal");
  const [prompt, setPrompt] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only ready photos can be a source: a 3D avatar has no photograph, and a
  // pending one has nothing stored yet.
  const { data: avatars } = useQuery({
    queryKey: ["avatars", orgId],
    queryFn: () => api.get<Avatar[]>(`/orgs/${orgId}/avatars`),
  });
  const sources = (avatars ?? []).filter((a) => a.kind === "photo" && a.status === "ready");

  const enabled = (current?.third_party_ai_enabled ?? true) && consent.aiEnabled;
  if (!enabled) {
    return (
      <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-600 dark:bg-white/[0.04] dark:text-gray-300">
        {t("genAiOff")}
      </p>
    );
  }

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { face_type: line, style, prompt: prompt.trim() };
      const created = sourceId
        ? await consent.withAi(t("genTitle"), (consentId) =>
            api.post<Creation>(`/orgs/${orgId}/creations/generate`, {
              ...body,
              source_avatar_id: sourceId,
              consent_id: consentId,
            })
          )
        : await api.post<Creation>(`/orgs/${orgId}/creations/generate`, body);
      if (!created) return; // "Not now": nothing was sent
      if (name.trim()) rememberCreationName(created.id, name.trim());
      queryClient.setQueryData(creationKey(orgId, created.id), created);
      void queryClient.invalidateQueries({ queryKey: draftsKey(orgId) });
      navigate(`/avatars/new/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? errorText(t, err.code, err.detail, err.retryAfter) : t("error"));
    } finally {
      setBusy(false);
    }
  };

  const pill = (selected: boolean) =>
    `inline-flex min-h-11 cursor-pointer items-center rounded-full border px-3.5 text-[13px] font-medium focus-within:ring-2 focus-within:ring-brand-500 ${
      selected
        ? "border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900"
        : "border-black/10 text-gray-600 hover:bg-black/5 dark:border-white/15 dark:text-gray-300 dark:hover:bg-white/10"
    }`;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void generate();
      }}
    >
      <fieldset>
        <legend className="label mb-1.5 block">{t("genLine")}</legend>
        <div className="flex flex-wrap gap-2">
          {LINE_ORDER.map((id) => (
            <label key={id} className={pill(line === id)}>
              <input
                type="radio"
                name="gen-line"
                value={id}
                className="sr-only"
                checked={line === id}
                onChange={() => setLine(id)}
              />
              {t(LINES[id].label)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="label mb-1.5 block">{t("genStyle")}</legend>
        <div className="flex flex-wrap gap-2">
          {ADJUST_STYLES.map((s) => (
            <label key={s} className={pill(style === s)}>
              <input
                type="radio"
                name="gen-style"
                value={s}
                className="sr-only"
                checked={style === s}
                onChange={() => setStyle(s)}
              />
              {t(`genStyle_${s}`)}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label className="label mb-1.5 block" htmlFor="gen-prompt">
          {t("genPrompt")}
        </label>
        <textarea
          id="gen-prompt"
          className="input min-h-[72px]"
          value={prompt}
          maxLength={MAX_PROMPT}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t(`genPromptPlaceholder_${line}`)}
          aria-describedby="gen-prompt-count"
        />
        <p id="gen-prompt-count" className="mt-1 text-end text-xs tabular-nums text-gray-500 dark:text-gray-400">
          {t("genPromptCount", { count: prompt.length, max: MAX_PROMPT })}
        </p>
      </div>

      <div>
        <label className="label mb-1.5 block" htmlFor="gen-source">
          {t("genSource")}
        </label>
        <select id="gen-source" className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
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

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn-primary min-h-11" disabled={busy}>
          {busy ? <Spinner className="h-4 w-4" /> : <Icon name="sparkles" className="h-4 w-4" />}
          {busy ? t("genWorking") : t("generate")}
        </button>
        <span className="text-[12.5px] text-gray-500 dark:text-gray-400">{t("genThenWizard")}</span>
      </div>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {consent.dialog}
    </form>
  );
}
