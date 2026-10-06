import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { Field } from "@/components/ui/Field";
import { FieldError } from "@/components/ui/FieldError";
import { FileInput } from "@/components/ui/FileInput";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { useImportAvatar, useStockAvatars } from "@/features/avatars/api";
import { Avaturn3DPanel } from "@/features/avatars/components/Avaturn3DPanel";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";
import type { Avatar } from "@/lib/types";

/**
 * The ways to add an avatar that are not the wizard's: the stock gallery,
 * a 3D model (a .glb file or a URL), and Avaturn's 3D editor. Folded under
 * the wizard's first step, so the two big choices stay the one thing on
 * screen. (Generating from words is the wizard's own "Generate with AI".)
 */
export function OtherWays({ orgId }: { orgId: string }) {
  const { t } = useT();
  const navigate = useNavigate();
  const glbInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [modelUrl, setModelUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: stock } = useStockAvatars();
  const imports = useImportAvatar(orgId);

  // Each import resolves once the list knows the new avatar: its page next.
  const created = (avatar: Avatar) => navigate(`/avatars/${avatar.id}`);
  const failed = (err: unknown) => setError(err instanceof ApiError ? err.detail : t("error"));

  const uploadModel = async (file: File) => {
    setError(null);
    try {
      created(
        await imports.fromFile.mutateAsync({
          file,
          name: name.trim() || file.name.replace(/\.\w+$/, ""),
          onProgress: setProgress,
        })
      );
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
      created(await imports.fromUrl.mutateAsync({ url: modelUrl.trim(), name: name.trim() }));
    } catch (err) {
      failed(err);
    } finally {
      setImporting(false);
    }
  };

  const fromStock = async (stockId: string) => {
    setError(null);
    try {
      created(await imports.fromStock.mutateAsync({ stockId, name: name.trim() }));
    } catch (err) {
      failed(err);
    }
  };

  return (
    <Card as="details" className="group mx-auto mt-8 max-w-4xl bg-white/60 px-5 py-4 shadow-none dark:bg-panel/60">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-gray-700 dark:text-gray-200">
        <span>{t("wzOtherWays")}</span>
        <Icon name="chevron" className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90 rtl:-scale-x-100" />
      </summary>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("createOtherWaysHint")}</p>

      <Field id="other-name" label={t("createOtherName")} className="mt-5 max-w-sm">
        <Input value={name} maxLength={128} onChange={(e) => setName(e.target.value)} placeholder="Ava" />
      </Field>
      {error && <FieldError className="mt-3 text-sm">{error}</FieldError>}

      <h3 className="mb-3 mt-8 text-lg font-medium">{t("stockGallery")}</h3>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6 sm:gap-4">
        {stock?.map((item) => (
          <ChoiceCard
            key={item.id}
            look="card"
            className="flex flex-col items-center gap-2 p-2 transition-shadow hover:shadow-md"
            onClick={() => void fromStock(item.id)}
          >
            <img src={item.image_url} alt="" className="aspect-square w-full rounded-lg object-cover" />
            <span className="text-xs font-medium">{item.name}</span>
          </ChoiceCard>
        ))}
      </div>

      <h3 className="mb-3 mt-10 text-lg font-medium">{t("model3dTitle")}</h3>
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            icon="cube"
            onClick={() => glbInput.current?.click()}
            disabled={progress !== null}
          >
            {t("createGlbUpload")}
          </Button>
          <FileInput
            ref={glbInput}
            accept=".glb,model/gltf-binary"
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
          <Field id="rpm-url" label={t("model3dUrl")} hint={t("model3dHint")} className="min-w-0 flex-1 basis-64">
            <Input
              placeholder="https://models.readyplayer.me/….glb"
              value={modelUrl}
              onChange={(e) => setModelUrl(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={importing || !modelUrl.trim()}>
            {importing ? "…" : t("create")}
          </Button>
        </form>
      </Card>

      <h3 className="mb-1 mt-10 text-lg font-medium">{t("avaturnTitle")}</h3>
      <p className="mb-3 text-[13px] text-gray-500 dark:text-gray-400">{t("avaturnSubtitle")}</p>
      <Avaturn3DPanel orgId={orgId} />
    </Card>
  );
}
