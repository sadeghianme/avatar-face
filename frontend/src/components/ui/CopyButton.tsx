import { useEffect, useState } from "react";

import { Button, type ButtonProps } from "@/components/ui/Button";
import type { IconLike } from "@/components/ui/Icon";

/**
 * A button that copies `text` to the clipboard and says so for a moment
 * (`copiedLabel`, and `copiedIcon` in place of `icon`, 1.5s). The words
 * are the caller's, translated. A screen reader hears it too, as a status
 * message: the focused button's own name changing is announced by some
 * readers and not others, so `copiedLabel` is also put in a polite live
 * region beside it, there (empty) from the start so the change is heard.
 */
export function CopyButton({
  text,
  label,
  copiedLabel,
  icon,
  copiedIcon,
  variant = "secondary",
  onCopied,
  ...rest
}: Omit<ButtonProps, "onClick" | "children"> & {
  text: string;
  label: string;
  copiedLabel?: string;
  copiedIcon?: IconLike;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <>
      <Button
        variant={variant}
        icon={copied && copiedIcon ? copiedIcon : icon}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            onCopied?.();
          });
        }}
        {...rest}
      >
        {copied && copiedLabel ? copiedLabel : label}
      </Button>
      <span role="status" className="sr-only">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}
