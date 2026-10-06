/**
 * The ids a Field hands its control: the control's own (the label's
 * htmlFor), the hint's and the error's, and the aria-describedby that names
 * whichever of those two are on screen, hint first. Framework-free, so the
 * wiring is tested with `node --test`.
 */
export interface FieldIds {
  controlId: string;
  hintId: string;
  errorId: string;
  /** Undefined when there is neither a hint nor an error. */
  describedBy: string | undefined;
}

export function fieldIds(controlId: string, shown: { hint?: boolean; error?: boolean } = {}): FieldIds {
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy = [shown.hint && hintId, shown.error && errorId].filter(Boolean).join(" ") || undefined;
  return { controlId, hintId, errorId, describedBy };
}

/**
 * A control's own aria-describedby joined to its field's: the field's
 * first (the hint and the error read before anything the control adds).
 */
export function joinDescribedBy(...ids: (string | undefined)[]): string | undefined {
  return ids.filter(Boolean).join(" ") || undefined;
}
