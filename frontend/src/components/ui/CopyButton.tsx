import { useEffect, useState } from "react";

import { Button, type ButtonProps } from "@/components/ui/Button";

/**
 * A button that copies `text` to the clipboard and says so for a moment
 * (`copiedLabel`, 1.5s). The words are the caller's, translated.
 */
export function CopyButton({
  text,
  label,
  copiedLabel,
  variant = "secondary",
  onCopied,
  ...rest
}: Omit<ButtonProps, "onClick" | "children"> & {
  text: string;
  label: string;
  copiedLabel?: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant={variant}
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
  );
}
