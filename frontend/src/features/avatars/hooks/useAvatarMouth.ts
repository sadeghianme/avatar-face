import { attachAvatarMouth, type AttachedMouth, type AvatarMouthConfig } from "@liveface/embed/mouth";
import { useEffect, useRef, useState } from "react";
import { mouthConfigToLoad, mouthLoadIdentity } from "@/features/avatars/mouth-config";

/** The motion template, served by the API next to the widget bundles. The
 *  loader finds the standard teeth beside it (/api/mouth-teeth.webp), for
 *  an avatar without a teeth photo of its own, as visitors' widgets do. */
export const MOUTH_MOTION_URL = "/api/mouth-motion.json";

type MouthHost = Parameters<typeof attachAvatarMouth>[0];

/**
 * Put an avatar's configured mouth on a running preview engine.
 *
 * The config reaches the loader whole, as the widget hands it on, so the
 * avatar's own motion (`motion_url`) plays here exactly as visitors get it.
 * Reloads only when the renderer, the teeth photo or the motion changes; the
 * fit profile is applied live on the attached mouth, so dragging a slider
 * never refetches anything. Any failure leaves the classic mouth, which
 * always works.
 */
export function useAvatarMouth(
  engine: MouthHost | null,
  config: AvatarMouthConfig | null
): { failed: boolean } {
  const attached = useRef<AttachedMouth | null>(null);
  const [failed, setFailed] = useState(false);
  const active = config?.renderer === "continuous";
  // Presigned URLs are re-signed on every refetch. Identity is the path of
  // the teeth photo and of the motion; the freshest signatures are kept in a
  // ref for when a reload IS needed.
  const identity = mouthLoadIdentity(config);
  const latest = useRef(config);
  latest.current = config;
  const profile = config?.profile;

  useEffect(() => {
    setFailed(false);
    if (!engine || !active) return;
    const abort = new AbortController();
    attachAvatarMouth(engine, mouthConfigToLoad(latest.current), MOUTH_MOTION_URL, abort.signal)
      .then((mouth) => {
        if (abort.signal.aborted) mouth.detach();
        else attached.current = mouth;
      })
      .catch(() => !abort.signal.aborted && setFailed(true));
    return () => {
      abort.abort();
      attached.current?.detach();
      attached.current = null;
    };
    // `profile` is applied by the effect below; listing it here would reload
    // the teeth photo on every slider tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, active, identity]);

  const profileKey = JSON.stringify(profile ?? null);
  useEffect(() => {
    attached.current?.setProfile(profile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey]);

  return { failed };
}
