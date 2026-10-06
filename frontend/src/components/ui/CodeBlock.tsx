import type { ReactNode } from "react";

import { CopyButton } from "@/components/ui/CopyButton";
import { cx } from "@/lib/cx";

/**
 * Code to read and copy (`.code-block`): dark, monospaced, and it scrolls
 * inside itself rather than pushing the page sideways on a phone. With
 * `copy`, a header row holds `header` (a hint) and a Copy button.
 */
export function CodeBlock({
  code,
  header,
  copy,
  className,
  preClassName,
}: {
  code: string;
  header?: ReactNode;
  /** The Copy button's words; no button without them. */
  copy?: { label: string; copiedLabel: string };
  className?: string;
  preClassName?: string;
}) {
  return (
    <div className={className}>
      {(header || copy) && (
        <div className="mb-2 flex items-center justify-between gap-3">
          {header ?? <span />}
          {copy && (
            <CopyButton text={code} label={copy.label} copiedLabel={copy.copiedLabel} size="sm" className="shrink-0" />
          )}
        </div>
      )}
      <pre className={cx("code-block", preClassName)}>{code}</pre>
    </div>
  );
}
