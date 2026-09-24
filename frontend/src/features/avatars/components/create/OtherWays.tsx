import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { Avaturn3DPanel } from "@/features/avatars/components/Avaturn3DPanel";
import { GenerateCreation } from "@/features/avatars/components/create/GenerateCreation";
import { Icon } from "@/components/ui/Icon";
import { api, ApiError, uploadWithProgress } from "@/lib/api";
import type { Avatar, StockAvatar } from "@/lib/types";

interface Created {
  avatar: Avatar;
  upload_url: string;
}

/**
 * Every way to make an avatar that does not start from a photo of one's
 * own: AI generation, the stock gallery, a 3D model (a .glb file or a URL),
 * and Avaturn's 3D editor.
 *
 * Generation is a creation: it starts one and continues in the wizard, so
 * a generated face passes the same points, the same confirmation and the
 * same statement as an upload. The others are unchanged from before the
 * wizard.
 */
export function OtherWays({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const glbInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [modelUrl, setModelUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: stock } = useQuery({
    queryKey: ["stock-avatars"],
    queryFn: () => api.get<StockAvatar[]>("/stock-avatars"),
  });

  const created = async (avatar: Avatar) => {
    await queryClient.invalidateQueries({ queryKey: ["avatars", orgId] });
    navigate(`/avatars/${avatar.id}`);
  };
  const failed = (err: unknown) => setError(err instanceof ApiError ? err.detail : t("error"));

  const uploadModel = async (file: File) => {
    setError(null);
    try {
      const made = await api.post<Created>(`/orgs/${orgId}/avatars`, {
        name: name.trim() || file.name.replace(/\.\w+$/, ""),
        content_type: "model/gltf-binary",
      });
      setProgress(0);
      // .glb files often have an empty file.type; the presigned PUT signs
      // the content type, so it is set explicitly.
      await uploadWithProgress(made.upload_url, file, setProgress, "model/gltf-binary");
      await api.post(`/orgs/${orgId}/avatars/${made.avatar.id}/uploaded`);
      await created(made.avatar);
    } catch (err) {
      setProgress(null);
      failed(err);
    }
  };

  const fromModelUrl = async () => {
    if (!modelUrl.trim()) return;
    setError(null);
    setImporting(true);
    try {
      await created(
        await api.post<Avatar>(`/orgs/${orgId}/avatars/from-url`, { url: modelUrl.trim(), name: name.trim() })
      );
    } catch (err) {
      failed(err);
    } finally {
      setImporting(false);
    }
  };

  const fromStock = async (stockId: string) => {
    setError(null);
    try {
      await created(
        await api.post<Avatar>(`/orgs/${orgId}/avatars/from-stock`, { stock_id: stockId, name: name.trim() })
      );
    } catch (err) {
      failed(err);
    }
  };

  return (
    <section aria-labelledby="other-ways-heading" className="mt-12 border-t border-gray-200 pt-8 dark:border-line">
      <h2 id="other-ways-heading" className="text-xl font-semibold tracking-[-0.02em]">
        {t("createOtherWays")}
      </h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("createOtherWaysHint")}</p>

      <div className="mt-5 max-w-sm">
        <label className="label" htmlFor="other-name">
          {t("createOtherName")}
        </label>
        <input
          id="other-name"
          className="input"
          value={name}
          maxLength={128}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ava"
        />
      </div>
      {error && (
        <p role="alert" className="field-error mt-3 text-sm">
          {error}
        </p>
      )}

      <h3 className="mb-1 mt-8 text-lg font-medium">{t("genTitle")}</h3>
      <p className="mb-3 text-[13px] text-gray-500 dark:text-gray-400">{t("genScratchTitle")}</p>
      <GenerateCreation orgId={orgId} name={name} />

      <h3 className="mb-3 mt-10 text-lg font-medium">{t("stockGallery")}</h3>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6 sm:gap-4">
        {stock?.map((item) => (
          <button
            key={item.id}
            type="button"
            className="card flex flex-col items-center gap-2 p-2 transition-shadow hover:shadow-md"
            onClick={() => void fromStock(item.id)}
          >
            <img src={item.image_url} alt="" className="aspect-square w-full rounded-lg object-cover" />
            <span className="text-xs font-medium">{item.name}</span>
          </button>
        ))}
      </div>

      <h3 className="mb-3 mt-10 text-lg font-medium">{t("model3dTitle")}</h3>
      <div className="card space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => glbInput.current?.click()}
            disabled={progress !== null}
          >
            <Icon name="cube" className="h-4 w-4" />
            {t("createGlbUpload")}
          </button>
          <input
            ref={glbInput}
            type="file"
            accept=".glb,model/gltf-binary"
            className="hidden"
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void uploadModel(file);
            }}
          />
          {progress !== null && (
            <span className="text-xs tabular-nums text-gray-500" role="status">
              {t("createGlbProgress", { percent: Math.round(progress * 100) })}
            </span>
          )}
        </div>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void fromModelUrl();
          }}
        >
          <div className="min-w-0 flex-1 basis-64">
            <label className="label" htmlFor="rpm-url">
              {t("model3dUrl")}
            </label>
            <input
              id="rpm-url"
              className="input"
              placeholder="https://models.readyplayer.me/….glb"
              value={modelUrl}
              onChange={(e) => setModelUrl(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-400">{t("model3dHint")}</p>
          </div>
          <button type="submit" className="btn-primary" disabled={importing || !modelUrl.trim()}>
            {importing ? "…" : t("create")}
          </button>
        </form>
      </div>

      <h3 className="mb-1 mt-10 text-lg font-medium">{t("avaturnTitle")}</h3>
      <p className="mb-3 text-[13px] text-gray-500 dark:text-gray-400">{t("avaturnSubtitle")}</p>
      <Avaturn3DPanel orgId={orgId} />
    </section>
  );
}
