import { forwardRef, type HTMLAttributes, type LabelHTMLAttributes } from "react";

import { cx } from "@/lib/cx";

export interface LabelProps extends LabelHTMLAttributes<HTMLElement>, Omit<HTMLAttributes<HTMLElement>, "color"> {
  /**
   * label (the default): one control's name, tied by `htmlFor` · p or span:
   * a group's name (a radio group, a row of swatches), which the group
   * names by id in its aria-labelledby.
   */
  as?: "label" | "p" | "span";
  /** field (the default): the field label look (`.label`) · plain: no
   *  look of its own, the caller's className (a row that wraps a control). */
  look?: "field" | "plain";
  /** Read by a screen reader, not shown (a range that is its own picture). */
  srOnly?: boolean;
}

/**
 * A name for a control or a group of them. Field draws its own; this is
 * for a control outside a Field, or a group of choices.
 */
export const Label = forwardRef<HTMLElement, LabelProps>(function Label(
  { as: Element = "label", look = "field", srOnly = false, htmlFor, className, ...rest },
  ref
) {
  const classes = cx(srOnly ? "sr-only" : look === "field" && "label", className);
  if (Element === "label") {
    // Tied by htmlFor, or wrapping its control (look="plain").
    return <label ref={ref as React.Ref<HTMLLabelElement>} htmlFor={htmlFor} className={classes} {...rest} />;
  }
  return <Element ref={ref as React.Ref<HTMLParagraphElement>} className={classes} {...rest} />;
});
