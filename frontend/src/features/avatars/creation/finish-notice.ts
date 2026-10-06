/** After finishing: the warnings kept for the avatar's page (see index.ts). */
import type { DraftStore } from "./marks.ts";
import type { FinishWarning } from "./types.ts";

/**
 * What the owner is told on the avatar's page when they arrive from the
 * wizard: the finish answer's warnings. The wizard navigates by itself once
 * the avatar is built, so the answer would die with the step; it is kept
 * for this tab under the avatar's id (sessionStorage), until dismissed.
 * Step 5 reads it back too, so a tab reloaded mid-build still says them.
 */
export interface FinishNotice {
  warnings: FinishWarning[];
}

const FINISH_NOTICE_PREFIX = "liveface.finishNotice.";

export const finishNoticeKey = (avatarId: string) => `${FINISH_NOTICE_PREFIX}${avatarId}`;

/** Keep the finish answer's warnings for the avatar's page. Kept even when
 * there are none: arriving from the wizard is itself worth knowing (the
 * page also says what step 5 gave a person's mouth: their own shapes and
 * teeth, or standard ones and why). */
export function rememberFinishNotice(store: DraftStore | null, avatarId: string, warnings: FinishWarning[]): void {
  try {
    store?.setItem(finishNoticeKey(avatarId), JSON.stringify({ warnings }));
  } catch {
    // best effort: without it the page shows what the avatar itself says
  }
}

/** The notice kept for this avatar, or null. Only well-formed warnings
 * come back: the entry is a tab's storage, which anything can edit. */
export function finishNoticeFor(store: DraftStore | null, avatarId: string): FinishNotice | null {
  try {
    const raw = store?.getItem(finishNoticeKey(avatarId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const list = (parsed as { warnings?: unknown } | null)?.warnings;
    if (!Array.isArray(list)) return null;
    const warnings = list
      .filter(
        (w): w is FinishWarning => Boolean(w) && typeof w.code === "string" && typeof (w.detail ?? "") === "string"
      )
      .map((w) => ({ code: w.code, detail: w.detail ?? "" }));
    return { warnings };
  } catch {
    return null;
  }
}

export function forgetFinishNotice(store: DraftStore | null, avatarId: string): void {
  try {
    store?.removeItem(finishNoticeKey(avatarId));
  } catch {
    // best effort
  }
}
