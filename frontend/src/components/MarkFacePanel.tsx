import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, ApiError } from "../lib/api";
import type { Avatar } from "../lib/types";
import type { AvatarEngine } from "@liveface/embed";

import { AvatarPreview } from "./AvatarPreview";
import { SpeakPanel } from "./SpeakPanel";

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
type RegionId = "head" | "left_eye" | "right_eye" | "mouth";
type Edge = keyof Box;

interface AnchorsResponse {
  anchors: {
    head: Box | null;
    left_eye: Box | null;
    right_eye: Box | null;
    mouth: Box | null;
    mouth_center: { x: number; y: number } | null;
  };
  image_size: [number, number];
}

const REGIONS: { id: RegionId; colour: string; ring: string }[] = [
  { id: "head", colour: "#a78bfa", ring: "rgba(167,139,250,0.9)" },
  { id: "left_eye", colour: "#38bdf8", ring: "rgba(56,189,248,0.9)" },
  { id: "right_eye", colour: "#38bdf8", ring: "rgba(56,189,248,0.9)" },
  { id: "mouth", colour: "#fb7185", ring: "rgba(251,113,133,0.9)" },
];

/** Where an edge handle sits on its box. */
function edgePosition(box: Box, edge: Edge): { x: number; y: number } {
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  if (edge === "left") return { x: box.left, y: cy };
  if (edge === "right") return { x: box.right, y: cy };
  if (edge === "top") return { x: cx, y: box.top };
  return { x: cx, y: box.bottom };
}

/**
 * Mark the face by hand.
 *
 * Auto-detection fits a human template, so on stylized art it lands in the
 * wrong place at the wrong size and every downstream behaviour inherits the
 * error. Here the user states the measurement directly — the four edges of
 * the head, of each eye, and of the mouth.
 *
 * Handles open on the detected positions, so a good detection means dragging
 * nothing. Nothing is written until Save: Test asks the server for the
 * corrected rig WITHOUT persisting and previews that exact object, so what
 * is tested is what gets stored.
 */
export function MarkFacePanel({
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
  const [boxes, setBoxes] = useState<Record<RegionId, Box> | null>(null);
  const [mouthCenter, setMouthCenter] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState<{ region: RegionId; edge: Edge | "center" } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [engine, setEngine] = useState<AvatarEngine | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["rig-anchors", avatar.id, avatar.rig_url],
    queryFn: () =>
      api.get<AnchorsResponse>(`/orgs/${orgId}/avatars/${avatar.id}/rig-anchors`),
    enabled: Boolean(avatar.rig_url),
    staleTime: 0,
  });

  useEffect(() => {
    if (!data || boxes) return;
    const a = data.anchors;
    if (!a.head || !a.left_eye || !a.right_eye || !a.mouth) return;
    setBoxes({ head: a.head, left_eye: a.left_eye, right_eye: a.right_eye, mouth: a.mouth });
    setMouthCenter(a.mouth_center);
  }, [data, boxes]);

  // Blob URLs are a real allocation; drop the previous one on every replace
  // and on unmount, or a few Test presses leak the whole rig each time.
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const body = useMemo(
    () =>
      boxes && {
        head: boxes.head,
        left_eye: boxes.left_eye,
        right_eye: boxes.right_eye,
        mouth: boxes.mouth,
        mouth_center: mouthCenter,
      },
    [boxes, mouthCenter]
  );

  if (!data || !boxes || !avatar.image_url) return null;
  const [imgW, imgH] = data.image_size;

  const onDrag = (event: React.PointerEvent) => {
    if (!dragging) return;
    const rect = containerRef.current!.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * imgW;
    const y = ((event.clientY - rect.top) / rect.height) * imgH;
    if (dragging.edge === "center") {
      setMouthCenter({ x, y });
      return;
    }
    const edge = dragging.edge;
    setBoxes((prev) => {
      if (!prev) return prev;
      const box = { ...prev[dragging.region] };
      // Each handle moves only its own edge, and cannot cross the opposite
      // one — a box turned inside out has a negative span, which reads as a
      // mirrored region rather than an obvious mistake.
      if (edge === "left") box.left = Math.min(x, box.right - 2);
      else if (edge === "right") box.right = Math.max(x, box.left + 2);
      else if (edge === "top") box.top = Math.min(y, box.bottom - 2);
      else box.bottom = Math.max(y, box.top + 2);
      return { ...prev, [dragging.region]: box };
    });
  };

  const runFit = async (persist: boolean) => {
    setBusy(persist ? "save" : "test");
    setError(null);
    try {
      const result = await api.post<{ rig: unknown; persisted: boolean }>(
        `/orgs/${orgId}/avatars/${avatar.id}/rig-fit`,
        { ...body, persist }
      );
      if (persist) {
        await queryClient.invalidateQueries({ queryKey: ["avatar", orgId, avatar.id] });
        onClose();
      } else {
        const blob = new Blob([JSON.stringify(result.rig)], { type: "application/json" });
        setPreviewUrl(URL.createObjectURL(blob));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(null);
    }
  };

  const pct = (v: number, total: number) => `${(v / total) * 100}%`;

  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-medium">{t("markFace")}</h3>
        <button className="btn-secondary px-3 py-1 text-xs" onClick={onClose} aria-label="close">
          ✕
        </button>
      </div>
      <p className="mb-3 text-xs text-gray-500">{t("markFaceHint")}</p>

      <div className="grid gap-4 md:grid-cols-[3fr_2fr]">
        <div
          ref={containerRef}
          className="relative touch-none select-none overflow-hidden rounded-lg bg-gray-100 dark:bg-gray-700"
          style={{ aspectRatio: `${imgW} / ${imgH}` }}
          onPointerMove={onDrag}
          onPointerUp={() => setDragging(null)}
          onPointerLeave={() => setDragging(null)}
        >
          <img src={avatar.image_url} alt="" className="h-full w-full object-fill" draggable={false} />

          {REGIONS.map(({ id, colour, ring }) => {
            const box = boxes[id];
            return (
              <div key={id}>
                {/* The box itself, so the four handles read as one region. */}
                <div
                  className="pointer-events-none absolute border-2 border-dashed"
                  style={{
                    left: pct(box.left, imgW),
                    top: pct(box.top, imgH),
                    width: pct(box.right - box.left, imgW),
                    height: pct(box.bottom - box.top, imgH),
                    borderColor: ring,
                  }}
                />
                {(["left", "right", "top", "bottom"] as Edge[]).map((edge) => {
                  const p = edgePosition(box, edge);
                  const active = dragging?.region === id && dragging.edge === edge;
                  return (
                    <button
                      key={edge}
                      aria-label={`${id} ${edge}`}
                      className="absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2
                        cursor-move items-center justify-center rounded-full"
                      style={{ left: pct(p.x, imgW), top: pct(p.y, imgH) }}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setDragging({ region: id, edge });
                      }}
                    >
                      <span
                        className={`block rounded-full border border-white/90 shadow
                          ${active ? "h-3.5 w-3.5 ring-2 ring-white" : "h-2.5 w-2.5"}`}
                        style={{ backgroundColor: colour }}
                      />
                    </button>
                  );
                })}
              </div>
            );
          })}

          {mouthCenter && (
            <button
              aria-label="mouth center"
              className="absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-move
                items-center justify-center rounded-full"
              style={{ left: pct(mouthCenter.x, imgW), top: pct(mouthCenter.y, imgH) }}
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                setDragging({ region: "mouth", edge: "center" });
              }}
            >
              <span className="block h-3 w-3 rounded-full border-2 border-white bg-rose-500 shadow" />
            </button>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-gray-500">{t("testBeforeSave")}</p>
          {previewUrl ? (
            <>
              <AvatarPreview
                rigUrl={previewUrl}
                textureUrl={avatar.image_url}
                size={280}
                onEngine={setEngine}
              />
              <div className="mt-3">
                <SpeakPanel engine={engine} orgId={orgId} />
              </div>
            </>
          ) : (
            <div className="flex h-[280px] items-center justify-center rounded-xl border border-dashed
              border-gray-300 text-center text-xs text-gray-500 dark:border-gray-600">
              {t("testHint")}
            </div>
          )}
        </div>
      </div>

      {error && <p className="field-error mt-3">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn-secondary" onClick={() => void runFit(false)} disabled={busy !== null}>
          {busy === "test" ? t("loading") : t("test")}
        </button>
        <button className="btn-primary" onClick={() => void runFit(true)} disabled={busy !== null}>
          {busy === "save" ? t("saving") : t("save")}
        </button>
        <button
          className="btn-secondary"
          onClick={() => {
            const a = data.anchors;
            if (a.head && a.left_eye && a.right_eye && a.mouth) {
              setBoxes({
                head: a.head,
                left_eye: a.left_eye,
                right_eye: a.right_eye,
                mouth: a.mouth,
              });
              setMouthCenter(a.mouth_center);
            }
            setPreviewUrl(null);
          }}
          disabled={busy !== null}
        >
          {t("resetDetected")}
        </button>
      </div>
    </div>
  );
}
