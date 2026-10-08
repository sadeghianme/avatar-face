import { ContinuousMouth } from "@liveface/embed/mouth/continuous-mouth";
import { useEffect, useState } from "react";

import type { ReferenceUpload } from "@/features/lab/api";

/**
 * The photographic mouth's recorded performance, loaded for the avatar in
 * the reference lab: on the member's own mouth photo once one is
 * uploaded, on the Reference's teeth for the authored sample, else on the
 * fitted mouth. Null while it loads; `error` says why it did not ("teeth":
 * the mouth photo could not be used, "load": anything else).
 */
export function usePerformanceMouth(authored: boolean, oralPhoto: ReferenceUpload | null) {
  const [performance, setPerformance] = useState<ContinuousMouth | null>(null);
  const [error, setError] = useState<"load" | "teeth" | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setPerformance(null);
    setError(null);
    void ContinuousMouth.load(
      "/lab/reference/performance.json",
      oralPhoto ?? (authored ? "reference" : undefined),
      abort.signal
    )
      .then((value) => {
        if (!abort.signal.aborted) setPerformance(value);
      })
      .catch((err) => {
        if (!abort.signal.aborted) setError(err instanceof Error && err.name === "DentalPhotoError" ? "teeth" : "load");
      });
    return () => abort.abort();
  }, [authored, oralPhoto]);
  return { performance, error };
}
