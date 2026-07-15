import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, ApiError } from "../lib/api";
import type { Avatar } from "../lib/types";

interface RigInfo {
  image_size: [number, number];
  points: [number, number][];
  mouth_indices: number[];
}

type HandleId = "mouth" | "leftEye" | "rightEye";

const LEFT_EYE_CENTER = 468; // iris centers are stable anchors
const RIGHT_EYE_CENTER = 473;

/**
 * Manual fit correction: drag the mouth/eye handles onto the right spots
 * when auto-detection misses (stylized art, rotated faces). Sends pixel
 * deltas to /rig-adjust, which rewrites the stored rig.
 */
export function AdjustFitPanel({
  avatar,
  orgId,
  onClose,
}: {
  avatar: Avatar;
  orgId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const [offsets, setOffsets] = useState<Record<HandleId, { dx: number; dy: number }>>({
    mouth: { dx: 0, dy: 0 },
    leftEye: { dx: 0, dy: 0 },
    rightEye: { dx: 0, dy: 0 },
  });
  const [mouthScale, setMouthScale] = useState(1);
  const [dragging, setDragging] = useState<HandleId | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: rig } = useQuery({
    queryKey: ["rig", avatar.id, avatar.rig_url],
    queryFn: async () => (await fetch(avatar.rig_url!)).json() as Promise<RigInfo>,
    enabled: Boolean(avatar.rig_url),
    staleTime: 0,
  });

  if (!rig || !avatar.image_url) return null;

  const [imgW, imgH] = rig.image_size;

  const mouthCenter = (() => {
    let x = 0;
    let y = 0;
    for (const i of rig.mouth_indices) {
      x += rig.points[i][0];
      y += rig.points[i][1];
    }
    return { x: x / rig.mouth_indices.length, y: y / rig.mouth_indices.length };
  })();

  const anchors: Record<HandleId, { x: number; y: number; label: string }> = {
    mouth: { ...mouthCenter, label: "👄" },
    leftEye: { x: rig.points[LEFT_EYE_CENTER][0], y: rig.points[LEFT_EYE_CENTER][1], label: "👁" },
    rightEye: { x: rig.points[RIGHT_EYE_CENTER][0], y: rig.points[RIGHT_EYE_CENTER][1], label: "👁" },
  };

  const toImageDelta = (event: React.PointerEvent, handle: HandleId) => {
    const box = containerRef.current!.getBoundingClientRect();
    const scale = imgW / box.width;
    const x = (event.clientX - box.left) * scale;
    const y = (event.clientY - box.top) * scale;
    setOffsets((prev) => ({
      ...prev,
      [handle]: { dx: x - anchors[handle].x, dy: y - anchors[handle].y },
    }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/avatars/${avatar.id}/rig-adjust`, {
        mouth_dx: offsets.mouth.dx,
        mouth_dy: offsets.mouth.dy,
        mouth_scale: mouthScale,
        left_eye_dx: offsets.leftEye.dx,
        left_eye_dy: offsets.leftEye.dy,
        right_eye_dx: offsets.rightEye.dx,
        right_eye_dy: offsets.rightEye.dy,
      });
      // Fresh detail fetch -> new signed rig URL -> preview remounts.
      await queryClient.invalidateQueries({ queryKey: ["avatar", orgId, avatar.id] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-medium">{t("adjustFit")}</h3>
        <button className="btn-secondary px-3 py-1 text-xs" onClick={onClose}>
          ✕
        </button>
      </div>
      <p className="mb-3 text-xs text-gray-500">{t("adjustFitHint")}</p>

      <div
        ref={containerRef}
        className="relative touch-none select-none overflow-hidden rounded-lg"
        style={{ aspectRatio: `${imgW} / ${imgH}` }}
        onPointerMove={(e) => dragging && toImageDelta(e, dragging)}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
      >
        <img src={avatar.image_url} alt="" className="h-full w-full object-fill" draggable={false} />
        {(Object.keys(anchors) as HandleId[]).map((id) => {
          const pos = {
            x: anchors[id].x + offsets[id].dx,
            y: anchors[id].y + offsets[id].dy,
          };
          const isMouth = id === "mouth";
          return (
            <button
              key={id}
              aria-label={id}
              className={`absolute flex -translate-x-1/2 -translate-y-1/2 cursor-move items-center
                justify-center rounded-full border-2 text-sm shadow
                ${isMouth ? "h-10 w-16 border-rose-400 bg-rose-400/25" : "h-8 w-8 border-sky-400 bg-sky-400/25"}
                ${dragging === id ? "ring-2 ring-white" : ""}`}
              style={{
                left: `${(pos.x / imgW) * 100}%`,
                top: `${(pos.y / imgH) * 100}%`,
                ...(isMouth ? { transform: `translate(-50%,-50%) scale(${mouthScale})` } : {}),
              }}
              onPointerDown={(e) => {
                e.preventDefault();
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                setDragging(id);
              }}
            >
              {anchors[id].label}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        <label className="label" htmlFor="mouth-scale">
          {t("mouthSize")}: {mouthScale.toFixed(2)}×
        </label>
        <input
          id="mouth-scale"
          type="range"
          min={0.5}
          max={2}
          step={0.05}
          value={mouthScale}
          onChange={(e) => setMouthScale(Number(e.target.value))}
          className="w-full"
        />
      </div>

      {error && <p className="field-error mt-2">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button className="btn-primary flex-1" disabled={saving} onClick={() => void save()}>
          {t("save")}
        </button>
        <button
          className="btn-secondary"
          onClick={() => {
            setOffsets({ mouth: { dx: 0, dy: 0 }, leftEye: { dx: 0, dy: 0 }, rightEye: { dx: 0, dy: 0 } });
            setMouthScale(1);
          }}
        >
          {t("reset")}
        </button>
      </div>
    </div>
  );
}
