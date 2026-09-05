import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CropBox } from "@/features/avatars/components/CropBox";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { api } from "@/lib/api";

/**
 * Prepare a photo before it becomes an avatar.
 *
 * Uploading used to create the avatar and start rigging at once, which put
 * every editing tool on the far side of the thing it was meant to prepare —
 * the rig was built from the uncropped original, and cropping afterwards
 * meant redoing work that had already happened.
 *
 * Nothing is created until Save. Each edit returns a new staged image and the
 * previous one is pushed onto a stack, so Undo is just stepping back a key.
 */

export interface Staged {
  key: string;
  url: string;
  width: number;
  height: number;
}

type Tool = null | "crop" | "generate";

const STYLES = ["photoreal", "illustrated", "anime", "render3d"] as const;

interface Candidate {
  key: string;
  url: string;
}

export function PhotoStudio({
  orgId,
  staged,
  onChange,
  onUndo,
  canUndo,
}: {
  orgId: string;
  staged: Staged;
  onChange: (next: Staged) => void;
  onUndo: () => void;
  canUndo: boolean;
}) {
  const { t } = useTranslation();
  const [tool, setTool] = useState<Tool>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [style, setStyle] = useState<string>("illustrated");
  const [note, setNote] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [rejected, setRejected] = useState<string[]>([]);

  const call = async <T,>(label: string, path: string, body: unknown): Promise<T | null> => {
    setBusy(label);
    setError(null);
    try {
      return await api.post<T>(`/orgs/${orgId}/staging${path}`, body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const removeBackground = async () => {
    const next = await call<Staged>("bg", "/remove-background", { key: staged.key });
    if (next) onChange(next);
  };

  const applyCrop = async (rect: { x: number; y: number; w: number; h: number }) => {
    const next = await call<Staged>("crop", "/crop", {
      key: staged.key,
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
    });
    if (next) {
      onChange(next);
      setTool(null);
    }
  };

  const generate = async () => {
    setCandidates(null);
    const result = await call<{ candidates: Candidate[]; rejected: string[] }>(
      "generate",
      "/generate",
      { key: staged.key, style, count: 2, note }
    );
    if (result) {
      setCandidates(result.candidates);
      setRejected(result.rejected);
    }
  };

  return (
    <div className="card">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* ---- the picture ---- */}
        <div>
          {tool === "crop" ? (
            <CropBox
              src={staged.url}
              busy={busy === "crop"}
              onCancel={() => setTool(null)}
              onApply={(rect) => void applyCrop(rect)}
            />
          ) : (
            <div className="relative overflow-hidden rounded-xl bg-[repeating-conic-gradient(#00000010_0%_25%,transparent_0%_50%)] bg-[length:20px_20px]">
              <img src={staged.url} alt="" className="block w-full" />
              {busy && busy !== "generate" && (
                <div className="absolute inset-0 grid place-items-center bg-black/50 text-white">
                  <Spinner className="h-7 w-7" />
                </div>
              )}
            </div>
          )}
          <p className="mt-2 text-center font-mono text-[12px] text-gray-400">
            {staged.width} × {staged.height}
          </p>
        </div>

        {/* ---- the tools ---- */}
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold uppercase tracking-wide text-gray-500">
            {t("tools")}
          </h3>

          <ToolButton
            icon="eraser"
            label={t("removeBg")}
            hint={t("removeBgHint")}
            busy={busy === "bg"}
            disabled={!!busy || tool !== null}
            onClick={() => void removeBackground()}
          />
          <ToolButton
            icon="crop"
            label={t("crop")}
            hint={t("cropHintShort")}
            active={tool === "crop"}
            disabled={!!busy}
            onClick={() => setTool(tool === "crop" ? null : "crop")}
          />
          <ToolButton
            icon="cube"
            label={t("genTitle")}
            hint={t("genSubtitleShort")}
            active={tool === "generate"}
            disabled={!!busy}
            onClick={() => setTool(tool === "generate" ? null : "generate")}
          />

          {canUndo && (
            <button
              className="btn-secondary mt-1 justify-center"
              onClick={onUndo}
              disabled={!!busy}
            >
              <Icon name="undo" className="me-1.5 inline h-4 w-4" />
              {t("undo")}
            </button>
          )}

          {error && <p className="field-error mt-1">{error}</p>}
        </div>
      </div>

      {/* ---- generation, below so it has room ---- */}
      {tool === "generate" && (
        <div className="mt-6 border-t border-black/[0.07] pt-5 dark:border-white/[0.07]">
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

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              className="input flex-1"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("genNotePlaceholder")}
            />
            <button
              className="btn-primary shrink-0"
              onClick={() => void generate()}
              disabled={busy === "generate"}
            >
              {busy === "generate" ? (
                <Spinner className="me-1.5 inline h-4 w-4" />
              ) : (
                <Icon name="cube" className="me-1.5 inline h-4 w-4" />
              )}
              {busy === "generate" ? t("genWorking") : t("generate")}
            </button>
          </div>
          <p className="mt-2 text-[12.5px] text-gray-500 dark:text-gray-400">
            {t("genSourceHint")} {t("genCost")}
          </p>

          {busy === "generate" && (
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="grid aspect-square animate-pulse place-items-center rounded-xl bg-black/[0.05] text-gray-400 dark:bg-white/[0.06]"
                >
                  <Spinner className="h-6 w-6" />
                </div>
              ))}
            </div>
          )}

          {candidates && busy !== "generate" && (
            <div className="mt-4">
              {candidates.length > 0 ? (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  {candidates.map((c) => (
                    <button
                      key={c.key}
                      className="group text-start"
                      onClick={() => {
                        onChange({ ...staged, key: c.key, url: c.url });
                        setCandidates(null);
                        setTool(null);
                      }}
                    >
                      <div className="overflow-hidden rounded-xl border border-black/[0.08] transition-shadow group-hover:shadow-lg dark:border-white/[0.1]">
                        <img src={c.url} alt="" className="block w-full" />
                      </div>
                      <p className="mt-1.5 text-[12.5px] text-gray-500">{t("genUseThis")}</p>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="field-error">{t("genNoneUsable")}</p>
              )}

              {rejected.length > 0 && (
                <div className="mt-3 rounded-xl bg-black/[0.03] p-3 dark:bg-white/[0.04]">
                  <p className="text-[12.5px] font-medium text-gray-600 dark:text-gray-300">
                    {t("genDiscarded")}
                  </p>
                  <ul className="mt-1 list-inside list-disc text-[12.5px] text-gray-500 dark:text-gray-400">
                    {rejected.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolButton({
  icon,
  label,
  hint,
  onClick,
  busy,
  active,
  disabled,
}: {
  icon: "eraser" | "crop" | "cube";
  label: string;
  hint: string;
  onClick: () => void;
  busy?: boolean;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-start gap-3 rounded-xl border p-3 text-start transition-colors disabled:opacity-40 ${
        active
          ? "border-brand-400 bg-brand-500/5"
          : "border-black/[0.08] hover:bg-black/[0.03] dark:border-white/[0.1] dark:hover:bg-white/[0.05]"
      }`}
    >
      <span className="mt-0.5 shrink-0 text-gray-500">
        {busy ? <Spinner className="h-[18px] w-[18px]" /> : <Icon name={icon} className="h-[18px] w-[18px]" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium">{label}</span>
        <span className="block text-[12px] text-gray-500 dark:text-gray-400">{hint}</span>
      </span>
    </button>
  );
}
