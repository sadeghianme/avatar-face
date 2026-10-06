/**
 * When a new account's personal organization is made (providers/org.tsx).
 *
 * Exactly once per user in this tab: the effect that asks runs again every
 * time the user object or the list changes, while the request may still be
 * in flight, and a second request must never be sent (the server answers it
 * with the same organization, but there is no reason to ask).
 */
export interface OrgSetupState {
  userId: string | null;
  /** The list of organizations has been loaded. */
  loaded: boolean;
  orgCount: number;
  /** The user id a request was already sent for (and has not failed). */
  requestedFor: string | null;
}

export function needsPersonalOrg(state: OrgSetupState): boolean {
  return Boolean(state.userId) && state.loaded && state.orgCount === 0 && state.requestedFor !== state.userId;
}

/** Is the workspace still being made, so pages wait (a loader, not a blank
 * page or a "Create organization" choice)? Not once it failed: the retry is
 * then shown. */
export function settingUpWorkspace(state: {
  userId: string | null;
  loaded: boolean;
  orgCount: number;
  failed: boolean;
}): boolean {
  return Boolean(state.userId) && (!state.loaded || (state.orgCount === 0 && !state.failed));
}
