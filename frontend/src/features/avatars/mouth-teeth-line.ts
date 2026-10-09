/**
 * The Mouth panel's teeth and kit line, as state and its transitions
 * (useMouthPanel keeps it with useReducer). Framework-free, so `npm test`
 * checks it.
 */

/** What changed in this visit that visitors do not see yet: the kit the
 * panel's job made, or a teeth photo the owner uploaded. */
export type Changed = "kit" | "upload" | null;

/**
 * `starting`: the kit is being asked for (the consent dialog, the POST),
 * not the wait for it. `error`: a refused or failed mouth request, said
 * beside its buttons rather than under the sliders (on a phone those are
 * a screen apart). The requests' own busy states are their mutations'.
 */
export interface TeethLine {
  starting: boolean;
  changed: Changed;
  error: string | null;
}

export type TeethEvent =
  | { type: "clearError" }
  | { type: "failed"; error: string }
  | { type: "changed"; changed: Changed }
  /** Asked again: whatever an earlier kit made is the draft's now. */
  | { type: "kitAsked" }
  | { type: "kitAnswered" };

export const TEETH_LINE_START: TeethLine = { starting: false, changed: null, error: null };

export function teethLine(state: TeethLine, event: TeethEvent): TeethLine {
  switch (event.type) {
    case "clearError":
      return { ...state, error: null };
    case "failed":
      return { ...state, error: event.error };
    case "changed":
      return { ...state, changed: event.changed };
    case "kitAsked":
      return { starting: true, error: null, changed: state.changed === "kit" ? null : state.changed };
    case "kitAnswered":
      return { ...state, starting: false };
  }
}
