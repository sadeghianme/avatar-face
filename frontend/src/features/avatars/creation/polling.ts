/** Polling a busy creation, and image URLs kept stable across polls (see index.ts). */
import type { Creation } from "./types.ts";

const POLL_FIRST_MS = 600;
const POLL_FACTOR = 1.5;
const POLL_MAX_MS = 5000;
/** A finish backs off no further than this: step 5 counts the mouth
 * shapes as they are made ("3 of 6", one every few seconds), and a count
 * that jumps by three at a time does not look live. A minute of it is
 * about thirty requests. */
export const FINISH_POLL_MAX_MS = 2000;

/**
 * Delay before the `attempt`-th poll (0-based) of one job. Ingest and
 * detection are about a second, so the first answers come quickly; a
 * background removal or a queue wait can take a minute, and a tab left
 * open on it should not ask twice a second the whole time. A finish
 * (`finishing`) is watched more closely (FINISH_POLL_MAX_MS).
 */
export function pollDelay(attempt: number, finishing = false): number {
  const ceiling = finishing ? FINISH_POLL_MAX_MS : POLL_MAX_MS;
  return Math.min(ceiling, Math.round(POLL_FIRST_MS * POLL_FACTOR ** Math.max(0, attempt)));
}

// --- Stable image URLs --------------------------------------------------------------

export interface HeldUrl {
  url: string;
  at: number;
}

// Presigned URLs live an hour; one is reused for at most this long, so a
// held URL always has most of its life left when something reloads it.
export const URL_REUSE_MS = 15 * 60 * 1000;

const pathOf = (url: string) => url.split("?")[0];

/**
 * The creation with each step's URL replaced by the one already held for
 * the same image, when it is recent enough.
 *
 * Every response signs its URLs afresh, so the same image arrives under a
 * new URL on every poll. The photo would reload, and the talking preview
 * (whose engine restarts when its texture URL changes) would flicker, each
 * time the creation is refetched. Step keys are unique per image, so the
 * path names the image and only the signature is new.
 */
export function stabilizeUrls(
  creation: Creation,
  held: Map<string, HeldUrl>,
  now: number,
  maxAge: number = URL_REUSE_MS
): Creation {
  let changed = false;
  const steps = creation.steps.map((step) => {
    const path = pathOf(step.url);
    const known = held.get(path);
    if (known && now - known.at < maxAge) {
      if (known.url === step.url) return step;
      changed = true;
      return { ...step, url: known.url };
    }
    held.set(path, { url: step.url, at: now });
    return step;
  });
  return changed ? { ...creation, steps } : creation;
}
