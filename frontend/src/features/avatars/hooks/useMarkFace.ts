import { useCallback, useEffect, useReducer, useRef } from "react";

import { previewRigFit, useResetRig, useRigAnchors, useSaveRigFit } from "@/features/avatars/api";
import { type FaceMarks, type FitReason, marksToSend } from "@/features/avatars/face-marks";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";
import type { Avatar } from "@/lib/types";

// Once the owner has asked for a preview, it follows their marks: this long
// after the last drag or nudge, so holding an arrow key sends one request.
const LIVE_PREVIEW_DELAY_MS = 450;

/** The marks being placed and the preview that follows them. */
interface Marking {
  marks: FaceMarks | null;
  /** The fitted rig's blob URL, once there is a preview. */
  previewUrl: string | null;
  /** The marks the preview shows; the preview is live once there is one. */
  previewed: FaceMarks | null;
  live: boolean;
  previewing: boolean;
  /** What the server would refuse about these marks. */
  reasons: FitReason[];
  error: string | null;
}

type MarkingEvent =
  | { type: "opened"; marks: FaceMarks }
  | { type: "moved"; marks: FaceMarks }
  | { type: "test" }
  | { type: "previewing" }
  | { type: "previewed"; url: string; reasons: FitReason[]; marks: FaceMarks }
  | { type: "refused"; reasons: FitReason[] }
  | { type: "failed"; error: string }
  | { type: "stopped" }
  | { type: "settled" }
  | { type: "busy" };

const START: Marking = {
  marks: null,
  previewUrl: null,
  previewed: null,
  live: false,
  previewing: false,
  reasons: [],
  error: null,
};

function marking(state: Marking, event: MarkingEvent): Marking {
  switch (event.type) {
    case "opened":
      return state.marks ? state : { ...state, marks: event.marks };
    case "moved":
      // A moved point (or all of them, back to the detected ones) clears
      // what the server said about the old ones.
      return { ...state, marks: event.marks, reasons: [] };
    case "test":
      return { ...state, live: true, previewed: null };
    case "previewing":
      return { ...state, previewing: true, error: null };
    case "previewed":
      return { ...state, previewUrl: event.url, reasons: event.reasons, previewed: event.marks };
    case "refused":
      return { ...state, reasons: event.reasons };
    case "failed":
      return { ...state, error: event.error };
    case "stopped":
      return { ...state, live: false };
    case "settled":
      return { ...state, previewing: false };
    case "busy":
      return { ...state, error: null };
  }
}

/**
 * Marking the face by hand (MarkFacePanel draws it): the marks the panel
 * opens with (the server's, for the avatar's line), the live preview of
 * the rig they would make (fitted, NOT saved, once Test is pressed, then
 * after each move), what the server would refuse, and Save or Re-detect,
 * each closing the panel once done.
 */
export function useMarkFace(avatar: Avatar, orgId: string, onClose: () => void) {
  const { t } = useT();
  const [state, dispatch] = useReducer(marking, START);
  // Answers can arrive out of order; only the newest request may land.
  const latest = useRef(0);

  const { data } = useRigAnchors(orgId, avatar);
  const saveFit = useSaveRigFit(orgId, avatar.id);
  const resetRig = useResetRig(orgId, avatar.id);
  const { marks, previewed, live, previewUrl } = state;

  useEffect(() => {
    if (data) dispatch({ type: "opened", marks: data.anchors });
  }, [data]);

  // Blob URLs are a real allocation; drop the previous one on every replace
  // and on unmount, or a few previews leak the whole rig each time.
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl]
  );

  const fitFailed = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.code === "fit_invalid" && Array.isArray(err.body.reasons)) {
        dispatch({ type: "refused", reasons: err.body.reasons as FitReason[] });
      } else {
        dispatch({ type: "failed", error: err instanceof ApiError ? err.detail : t("error") });
      }
    },
    [t]
  );

  useEffect(() => {
    if (!live || !marks || marks === previewed) return;
    const request = ++latest.current;
    const timer = window.setTimeout(
      async () => {
        dispatch({ type: "previewing" });
        try {
          const result = await previewRigFit(orgId, avatar.id, data ? marksToSend(marks, data.anchors) : marks);
          if (request !== latest.current) return;
          const blob = new Blob([JSON.stringify(result.rig)], { type: "application/json" });
          dispatch({ type: "previewed", url: URL.createObjectURL(blob), reasons: result.reasons, marks });
        } catch (err) {
          if (request === latest.current) {
            fitFailed(err);
            dispatch({ type: "stopped" });
          }
        } finally {
          if (request === latest.current) dispatch({ type: "settled" });
        }
      },
      previewed ? LIVE_PREVIEW_DELAY_MS : 0
    );
    return () => window.clearTimeout(timer);
  }, [live, marks, previewed, orgId, avatar.id, data, fitFailed]);

  const save = async () => {
    if (!data || !marks) return;
    dispatch({ type: "busy" });
    try {
      // A head the owner did not touch goes without its outline diagonals,
      // which the server then keeps as saved (see marksToSend).
      await saveFit.mutateAsync(marksToSend(marks, data.anchors));
      onClose();
    } catch (err) {
      fitFailed(err);
    }
  };

  /** Throw the marking away and re-detect from the original photo. Saving
   * overwrites the rig, so without this a bad marking is unrecoverable. */
  const redetect = async () => {
    dispatch({ type: "busy" });
    try {
      await resetRig.mutateAsync();
      onClose();
    } catch (err) {
      dispatch({ type: "failed", error: err instanceof ApiError ? err.detail : t("error") });
    }
  };

  return {
    ...state,
    /** The picture's size and the detected marks; null until they arrive. */
    anchors: data ?? null,
    busy: saveFit.isPending ? ("save" as const) : resetRig.isPending ? ("redetect" as const) : null,
    move: (next: FaceMarks) => dispatch({ type: "moved", marks: next }),
    resetToDetected: () => {
      if (data) dispatch({ type: "moved", marks: data.anchors });
    },
    test: () => dispatch({ type: "test" }),
    save: () => void save(),
    redetect: () => void redetect(),
  };
}

export type MarkFaceState = ReturnType<typeof useMarkFace>;
