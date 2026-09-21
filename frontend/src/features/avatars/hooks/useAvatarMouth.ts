import { attachAvatarMouth, type AttachedMouth, type AvatarMouthConfig } from "@liveface/embed/mouth";
import { useEffect, useRef, useState } from "react";

/** The motion template, served by the API next to the widget bundles. */
export const MOUTH_MOTION_URL = "/api/mouth-motion.json";

type MouthHost = Parameters<typeof attachAvatarMouth>[0];

/**
 * Put an avatar's configured mouth on a running preview engine.
 *
 * Reloads only when the renderer or the teeth photo changes; the fit profile
 * is applied live on the attached mouth, so dragging a slider never refetches
 * anything. Any failure leaves the classic mouth, which always works.
 */
export function useAvatarMouth(
  engine: MouthHost | null,
  config: AvatarMouthConfig | null
): { failed: boolean } {
  const attached = useRef<AttachedMouth | null>(null);
  const [failed, setFailed] = useState(false);
  const active = config?.renderer === "continuous";
  // Presigned URLs are re-signed on every refetch. Identity is the path; the
  // freshest signature is kept in a ref for when a reload IS needed.
  const oralUrl = config?.oral?.image_url ?? null;
  const oralRigUrl = config?.oral?.rig_url ?? null;
  const oralIdentity = oralUrl ? oralUrl.split("?")[0] : null;
  const latestOral = useRef({ oralUrl, oralRigUrl });
  latestOral.current = { oralUrl, oralRigUrl };
  const profile = config?.profile;

  useEffect(() => {
    setFailed(false);
    if (!engine || !active) return;
    const abort = new AbortController();
    const { oralUrl: image, oralRigUrl: rig } = latestOral.current;
    const oral = image && rig ? { image_url: image, rig_url: rig } : null;
    attachAvatarMouth(engine, { renderer: "continuous", profile, oral }, MOUTH_MOTION_URL, abort.signal)
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
  }, [engine, active, oralIdentity]);

  const profileKey = JSON.stringify(profile ?? null);
  useEffect(() => {
    attached.current?.setProfile(profile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey]);

  return { failed };
}
