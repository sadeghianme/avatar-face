import { createContext, type ReactNode, useContext, useId } from "react";

import { fieldIds, joinDescribedBy } from "@/components/ui/field-ids";
import { FieldError } from "@/components/ui/FieldError";
import { cx } from "@/lib/cx";

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * What a control inside a Field takes from it: its id (the label's
 * htmlFor), aria-describedby (the hint, the error), aria-invalid. The
 * control's own props win where it sets them; its own describedby is added
 * after the field's. Outside a Field, the props pass through unchanged.
 */
export function useFieldControl(props: {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
}) {
  const field = useContext(FieldContext);
  return {
    id: props.id ?? field?.id,
    "aria-describedby": joinDescribedBy(field?.describedBy, props["aria-describedby"]),
    "aria-invalid": props["aria-invalid"] ?? (field?.invalid || undefined),
  };
}

/**
 * A labelled control: the label, the control (an Input, Select, Textarea
 * placed inside), a hint under it, an error under that. The ids are wired
 * here (field-ids.ts), so a screen reader reads the label, the hint and the
 * error with the control, and an error marks it invalid.
 */
export function Field({
  label,
  hint,
  error,
  id,
  hideLabel = false,
  labelAside,
  className,
  labelClassName,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** The control's id; generated when absent. */
  id?: string;
  /** The label for a screen reader only (a search box that says it in its placeholder). */
  hideLabel?: boolean;
  /** Beside the label, at the end of its row ("Forgot password?"). */
  labelAside?: ReactNode;
  className?: string;
  labelClassName?: string;
  children: ReactNode;
}) {
  const generated = useId();
  const ids = fieldIds(id ?? generated, { hint: Boolean(hint), error: Boolean(error) });
  const labelElement = (
    <label htmlFor={ids.controlId} className={cx(hideLabel ? "sr-only" : "label", labelClassName)}>
      {label}
    </label>
  );
  return (
    <FieldContext.Provider value={{ id: ids.controlId, describedBy: ids.describedBy, invalid: Boolean(error) }}>
      <div className={className}>
        {labelAside ? (
          <div className="flex items-baseline justify-between gap-3">
            {labelElement}
            {labelAside}
          </div>
        ) : (
          labelElement
        )}
        {children}
        {hint && (
          <p id={ids.hintId} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {hint}
          </p>
        )}
        {error && <FieldError id={ids.errorId}>{error}</FieldError>}
      </div>
    </FieldContext.Provider>
  );
}
