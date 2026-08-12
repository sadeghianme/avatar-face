import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, ApiError } from "../lib/api";
import type { Avatar } from "../lib/types";
import type { AvatarEngine } from "@liveface/embed";

import { AvatarPreview } from "./AvatarPreview";
import { SpeakPanel } from "./SpeakPanel";

interface Pt {
  x: number;
  y: number;
}
/** A region's extremes as FREE 2D points, so a mouth can curve and an eye
 * can tilt. A box forced both corners to the same height. */
interface Marks {
  left: Pt;
  right: Pt;
  top: Pt;
  bottom: Pt;
  center?: Pt;
}
type RegionId = "head" | "left_eye" | "right_eye" | "mouth";
type Edge = "left" | "right" | "top" | "bottom" | "center";

/** A pupil is a circle: its center, and one point on its rim for radius. */
interface PupilM {
  center: Pt;
  rim: Pt;
}
type PupilId = "left_pupil" | "right_pupil";
const PUPILS: PupilId[] = ["left_pupil", "right_pupil"];
const PUPIL_COLOUR = "#fbbf24";

const EDGES: Edge[] = ["left", "right", "top", "bottom"];

interface AnchorsResponse {
  anchors: Record<RegionId, Marks | null> & Record<PupilId, PupilM | null>;
  image_size: [number, number];
}

const REGIONS: { id: RegionId; colour: string; ring: string }[] = [
  { id: "head", colour: "#a78bfa", ring: "rgba(167,139,250,0.9)" },
  { id: "left_eye", colour: "#38bdf8", ring: "rgba(56,189,248,0.9)" },
  { id: "right_eye", colour: "#38bdf8", ring: "rgba(56,189,248,0.9)" },
  { id: "mouth", colour: "#fb7185", ring: "rgba(251,113,133,0.9)" },
];

/** The outline through a region's four marks, drawn as a closed curve so the
 * handles read as one shape rather than four loose dots. */
function outline(m: Marks): string {
  return [m.top, m.right, m.bottom, m.left].map((p) => `${p.x},${p.y}`).join(" ");
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
  const [marks, setMarks] = useState<Record<RegionId, Marks> | null>(null);
  const [pupils, setPupils] = useState<Record<PupilId, PupilM> | null>(null);
  const [dragging, setDragging] = useState<
    { region: RegionId; edge: Edge } | { region: PupilId; edge: "center" | "rim" } | null
  >(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | "redetect" | null>(null);
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
    if (!data || marks) return;
    const a = data.anchors;
    if (!a.head || !a.left_eye || !a.right_eye || !a.mouth) return;
    setMarks({ head: a.head, left_eye: a.left_eye, right_eye: a.right_eye, mouth: a.mouth });
    // Pupils can be absent (synthetic fallback mesh has no iris points).
    if (a.left_pupil && a.right_pupil) {
      setPupils({ left_pupil: a.left_pupil, right_pupil: a.right_pupil });
    }
  }, [data, marks]);

  // Blob URLs are a real allocation; drop the previous one on every replace
  // and on unmount, or a few Test presses leak the whole rig each time.
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const body = useMemo(() => marks && { ...marks, ...(pupils ?? {}) }, [marks, pupils]);

  if (!data || !marks || !avatar.image_url) return null;
  const [imgW, imgH] = data.image_size;

  const onDrag = (event: React.PointerEvent) => {
    if (!dragging) return;
    const rect = containerRef.current!.getBoundingClientRect();
    // Free 2D placement: each handle carries its own x AND y, so the mouth
    // corners can sit at different heights and the fit picks up the tilt.
    const x = Math.max(0, Math.min(imgW, ((event.clientX - rect.left) / rect.width) * imgW));
    const y = Math.max(0, Math.min(imgH, ((event.clientY - rect.top) / rect.height) * imgH));
    if (dragging.region === "left_pupil" || dragging.region === "right_pupil") {
      const { region, edge } = dragging;
      setPupils((prev) => {
        if (!prev) return prev;
        const p = prev[region];
        // Dragging the center carries the rim along, so the radius holds.
        const next: PupilM =
          edge === "center"
            ? { center: { x, y }, rim: { x: p.rim.x + x - p.center.x, y: p.rim.y + y - p.center.y } }
            : { center: p.center, rim: { x, y } };
        return { ...prev, [region]: next };
      });
      return;
    }
    const { region, edge } = dragging;
    setMarks((prev) =>
      prev ? { ...prev, [region]: { ...prev[region], [edge]: { x, y } } } : prev
    );
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

  /** Throw the marking away and re-detect from the original photo. Saving
   * overwrites the rig, so without this a bad marking is unrecoverable. */
  const redetect = async () => {
    setBusy("redetect");
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/avatars/${avatar.id}/rig-reset`, {});
      await queryClient.invalidateQueries({ queryKey: ["avatar", orgId, avatar.id] });
      onClose();
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
            const m = marks[id];
            const handles: Edge[] = m.center ? [...EDGES, "center"] : EDGES;
            return (
              <div key={id}>
                {/* The outline through the marks, so four dots read as one
                    shape — and so a curved or tilted marking is visible as
                    such rather than looking like a mistake. */}
                <svg
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  viewBox={`0 0 ${imgW} ${imgH}`}
                  preserveAspectRatio="none"
                >
                  <polygon
                    points={outline(m)}
                    fill="none"
                    stroke={ring}
                    strokeWidth={Math.max(1, imgW / 400)}
                    strokeDasharray={`${imgW / 90} ${imgW / 140}`}
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
                {handles.map((edge) => {
                  const p = edge === "center" ? m.center! : m[edge];
                  const active = dragging?.region === id && dragging.edge === edge;
                  const isCenter = edge === "center";
                  return (
                    <button
                      key={edge}
                      aria-label={`${id} ${edge}`}
                      title={`${id} ${edge}`}
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
                          ${active ? "h-3.5 w-3.5 ring-2 ring-white" : "h-2.5 w-2.5"}
                          ${isCenter ? "ring-1 ring-white/70" : ""}`}
                        style={{ backgroundColor: colour }}
                      />
                    </button>
                  );
                })}
              </div>
            );
          })}

          {pupils &&
            PUPILS.map((id) => {
              const p = pupils[id];
              const r = Math.hypot(p.rim.x - p.center.x, p.rim.y - p.center.y);
              return (
                <div key={id}>
                  <svg
                    className="pointer-events-none absolute inset-0 h-full w-full"
                    viewBox={`0 0 ${imgW} ${imgH}`}
                    preserveAspectRatio="none"
                  >
                    <circle
                      cx={p.center.x}
                      cy={p.center.y}
                      r={r}
                      fill="none"
                      stroke="rgba(251,191,36,0.9)"
                      strokeWidth={Math.max(1, imgW / 400)}
                      strokeDasharray={`${imgW / 140} ${imgW / 200}`}
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  {(["center", "rim"] as const).map((edge) => {
                    const pt = p[edge];
                    const active = dragging?.region === id && dragging.edge === edge;
                    return (
                      <button
                        key={edge}
                        aria-label={`${id} ${edge}`}
                        title={`${id} ${edge}`}
                        className="absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2
                          cursor-move items-center justify-center rounded-full"
                        style={{ left: pct(pt.x, imgW), top: pct(pt.y, imgH) }}
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          setDragging({ region: id, edge });
                        }}
                      >
                        <span
                          className={`block rounded-full border border-white/90 shadow
                            ${active ? "h-3.5 w-3.5 ring-2 ring-white" : "h-2.5 w-2.5"}
                            ${edge === "center" ? "ring-1 ring-white/70" : ""}`}
                          style={{ backgroundColor: PUPIL_COLOUR }}
                        />
                      </button>
                    );
                  })}
                </div>
              );
            })}
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
              border-gray-300 text-center text-xs text-gray-500 dark:border-line">
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
          onClick={() => void redetect()}
          disabled={busy !== null}
          title={t("redetectHint")}
        >
          {busy === "redetect" ? t("loading") : t("redetect")}
        </button>
        <button
          className="btn-secondary"
          onClick={() => {
            const a = data.anchors;
            if (a.head && a.left_eye && a.right_eye && a.mouth) {
              setMarks({ head: a.head, left_eye: a.left_eye, right_eye: a.right_eye, mouth: a.mouth });
            }
            if (a.left_pupil && a.right_pupil) {
              setPupils({ left_pupil: a.left_pupil, right_pupil: a.right_pupil });
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
