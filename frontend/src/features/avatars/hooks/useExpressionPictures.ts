import type { ExpressionPictureSource } from "@liveface/embed";
import { useEffect, useRef } from "react";

/** What may take the pictures: AvatarEngine, or nothing (a 3D avatar). */
interface PictureHost {
  setExpressionPictures?: (source: ExpressionPictureSource | null) => Promise<void>;
}

/** A presigned URL's path: the same file whatever its signature. */
const path = (url: string | null | undefined) => (url ? url.split("?")[0] : "");

/**
 * Put an avatar's AI expression pictures on a running preview engine, as
 * visitors' widgets get them: the dashboard's draft (GET …/expressions) or
 * a share page's published snapshot. Loaded again only when the files
 * change (a new kit, Make again, Remove), never for a re-signed URL; none
 * takes them off (the animated expressions play).
 */
export function useExpressionPictures(
  engine: PictureHost | null,
  manifestUrl: string | null | undefined,
  imageUrls: Partial<Record<string, string>> | null | undefined
): void {
  const identity = [path(manifestUrl), ...Object.entries(imageUrls ?? {}).map(([k, v]) => `${k}=${path(v)}`)].join("|");
  const latest = useRef<ExpressionPictureSource | null>(null);
  latest.current = manifestUrl && imageUrls ? { manifestUrl, imageUrls } : null;
  useEffect(() => {
    if (!engine?.setExpressionPictures) return;
    void engine.setExpressionPictures(latest.current);
    return () => void engine.setExpressionPictures?.(null);
  }, [engine, identity]);
}
