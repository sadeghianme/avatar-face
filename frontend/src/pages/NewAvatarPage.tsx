import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { api, ApiError, uploadWithProgress } from "../lib/api";
import { useOrg } from "../lib/org";
import type { Avatar, StockAvatar } from "../lib/types";

interface Created {
  avatar: Avatar;
  upload_url: string;
}

export function NewAvatarPage() {
  const { t } = useTranslation();
  const { current } = useOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const { data: stock } = useQuery({
    queryKey: ["stock-avatars"],
    queryFn: () => api.get<StockAvatar[]>("/stock-avatars"),
  });

  const upload = async (file: File) => {
    if (!current) return;
    setError(null);
    try {
      const created = await api.post<Created>(`/orgs/${current.id}/avatars`, {
        name: name.trim() || file.name.replace(/\.\w+$/, ""),
        content_type: file.type,
      });
      setProgress(0);
      await uploadWithProgress(created.upload_url, file, setProgress);
      await api.post(`/orgs/${current.id}/avatars/${created.avatar.id}/uploaded`);
      await queryClient.invalidateQueries({ queryKey: ["avatars", current.id] });
      navigate(`/avatars/${created.avatar.id}`);
    } catch (err) {
      setProgress(null);
      setError(err instanceof ApiError ? err.detail : t("error"));
    }
  };

  const fromStock = async (stockId: string) => {
    if (!current) return;
    setError(null);
    try {
      const avatar = await api.post<Avatar>(`/orgs/${current.id}/avatars/from-stock`, {
        stock_id: stockId,
        name: name.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: ["avatars", current.id] });
      navigate(`/avatars/${avatar.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-2xl font-semibold">{t("newAvatar")}</h1>

      <label className="label" htmlFor="avatar-name">{t("avatarName")}</label>
      <input
        id="avatar-name"
        className="input mb-6"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Ava"
      />

      <div
        role="button"
        tabIndex={0}
        aria-label={t("uploadPhoto")}
        className={`card flex cursor-pointer flex-col items-center justify-center border-2 border-dashed py-12 text-center transition-colors ${
          dragging ? "border-brand-500 bg-brand-50 dark:bg-brand-700/10" : "border-gray-300 dark:border-gray-600"
        }`}
        onClick={() => fileInput.current?.click()}
        onKeyDown={(e) => e.key === "Enter" && fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) void upload(file);
        }}
      >
        <span className="mb-2 text-4xl">📷</span>
        <p className="text-gray-600 dark:text-gray-300">{t("dragOrClick")}</p>
        <p className="mt-1 text-xs text-gray-400">JPEG · PNG · WebP</p>
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>

      {progress !== null && (
        <div className="mt-4">
          <div className="h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className="h-full bg-brand-600 transition-all"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-end text-xs text-gray-500">{Math.round(progress * 100)}%</p>
        </div>
      )}
      {error && <p className="field-error mt-3">{error}</p>}

      <h2 className="mb-3 mt-10 text-lg font-medium">{t("stockGallery")}</h2>
      <div className="grid grid-cols-3 gap-4 sm:grid-cols-6">
        {stock?.map((item) => (
          <button
            key={item.id}
            className="card flex flex-col items-center gap-2 p-2 transition-shadow hover:shadow-md"
            onClick={() => void fromStock(item.id)}
          >
            <img
              src={item.image_url}
              alt={item.name}
              className="aspect-square w-full rounded-lg object-cover"
            />
            <span className="text-xs font-medium">{item.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
