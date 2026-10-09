import type { AvatarEngine } from "@liveface/embed";
import { ReferenceMouth } from "@liveface/embed/mouth/reference-mouth";
import { REFERENCE_POSES } from "@liveface/embed/mouth/reference-mouth-model";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { ReferenceUpload } from "@/features/lab/api";
import { useLipSyncComparison } from "@/features/lab/hooks/useLipSyncComparison";
import { usePerformanceMouth } from "@/features/lab/hooks/usePerformanceMouth";
import { useReferenceProfile } from "@/features/lab/hooks/useReferenceProfile";
import { REFERENCE_AVATAR, REFERENCE_AVATAR_PROFILE } from "@/features/lab/reference-avatar";
import { defaultVoiceSelection, type VoiceSelection } from "@/features/voices";
import { useT } from "@/i18n";
import type { Avatar } from "@/lib/types";

/** What the two previews show: which mouth, which pose (none while speech
 *  plays), the portrait or the mouth up close, and the member's own mouth
 *  photo, if any. */
interface Bench {
  photographic: boolean;
  pose: string | null;
  mouthOnly: boolean;
  oralPhoto: ReferenceUpload | null;
}

type BenchEvent =
  | { type: "mode"; photographic: boolean }
  | { type: "pose"; pose: string | null }
  | { type: "view"; mouthOnly: boolean }
  | { type: "oralPhoto"; photo: ReferenceUpload | null };

function bench(state: Bench, event: BenchEvent): Bench {
  switch (event.type) {
    case "mode":
      return { ...state, pose: "rest", photographic: event.photographic };
    case "pose":
      return { ...state, pose: event.pose };
    case "view":
      return { ...state, mouthOnly: event.mouthOnly };
    case "oralPhoto":
      // A new mouth photo is shown on the photographic mouth, at rest.
      return {
        ...state,
        pose: "rest",
        oralPhoto: event.photo,
        photographic: event.photo ? true : state.photographic,
      };
  }
}

/**
 * The reference lab's bench (ReferenceAvatarWorkspace draws it): the
 * baseline and the candidate mouth side by side on one avatar, frozen in a
 * pose or speaking the same timed phrase; the fit profile being drafted;
 * the member's own mouth photo; the script and the voice. Changing what is
 * compared stops what plays and goes back to rest.
 */
export function useReferenceWorkspace(avatar: Avatar, orgId: string) {
  const { t } = useT();
  const authored = avatar.id === REFERENCE_AVATAR.id;
  const draft = useReferenceProfile(orgId, avatar.id, authored ? REFERENCE_AVATAR_PROFILE : undefined);
  const [mouth] = useState(() => new ReferenceMouth(draft.profile));
  const [state, dispatch] = useReducer(bench, { photographic: true, pose: "rest", mouthOnly: false, oralPhoto: null });
  const { performance, error: performanceError } = usePerformanceMouth(authored, state.oralPhoto);
  const [baseline, setBaseline] = useState<AvatarEngine | null>(null);
  const [candidate, setCandidate] = useState<AvatarEngine | null>(null);
  const baselineReady = useCallback((engine: AvatarEngine | null) => setBaseline(engine), []);
  const candidateReady = useCallback((engine: AvatarEngine | null) => setCandidate(engine), []);
  const poseRef = useRef(state.pose);
  poseRef.current = state.pose;
  const readPose = useCallback(() => (poseRef.current ? REFERENCE_POSES[poseRef.current] : null), []);
  const comparison = useLipSyncComparison(orgId, baseline, candidate, true);
  const [text, setText] = useState<string>(t("lipSyncSample"));
  const [voice, setVoice] = useState(defaultVoiceSelection);

  useEffect(() => {
    mouth.setProfile(draft.profile);
    performance?.setProfile(draft.profile);
    if (candidate) candidate.tuning.mouthOpen = draft.profile.jawRange;
  }, [mouth, performance, draft.profile, candidate]);

  /** Stop what plays, then change what is compared. */
  const still = (event: BenchEvent) => {
    comparison.stop();
    dispatch(event);
  };

  return {
    ...state,
    authored,
    draft,
    mouth,
    performance,
    performanceError,
    comparison,
    readPose,
    baselineReady,
    candidateReady,
    /** Both previews have an engine. */
    ready: Boolean(baseline && candidate),
    text,
    setText,
    voice,
    /** The lab plays server voices only (their timing is what is compared). */
    supported: voice.provider !== "browser" && voice.provider !== "cloned",
    setVoice: (next: VoiceSelection) => {
      still({ type: "pose", pose: "rest" });
      setVoice(next);
    },
    freeze: (pose: string) => still({ type: "pose", pose }),
    setPhotographic: (photographic: boolean) => still({ type: "mode", photographic }),
    setMouthOnly: (mouthOnly: boolean) => dispatch({ type: "view", mouthOnly }),
    setOralPhoto: (photo: ReferenceUpload | null) => still({ type: "oralPhoto", photo }),
    /** Speech plays through the pose: none is held while it does. */
    unfreeze: () => dispatch({ type: "pose", pose: null }),
    generate: () => {
      dispatch({ type: "pose", pose: null });
      void comparison.generate(text, voice);
    },
    replay: () => {
      dispatch({ type: "pose", pose: null });
      void comparison.replay();
    },
  };
}

export type ReferenceWorkspace = ReturnType<typeof useReferenceWorkspace>;
