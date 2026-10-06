import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Textarea";
import type { useLipSyncComparison } from "@/features/lab/hooks/useLipSyncComparison";

type Comparison = ReturnType<typeof useLipSyncComparison>;

/** The lab's script cap, as the server enforces it. */
const SCRIPT_MAX = 600;

/**
 * Replay, Pause or Resume, Stop: the last test phrase, played again in
 * both previews. `onReplay` and `onStop` replace the plain calls where the
 * workspace has more to reset (the reference lab's frozen pose).
 */
export function PlaybackButtons({
  comparison,
  ready,
  onReplay = () => void comparison.replay(),
  onStop = comparison.stop,
}: {
  comparison: Comparison;
  /** Both previews have an engine. */
  ready: boolean;
  onReplay?: () => void;
  onStop?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={!comparison.payload || !ready || comparison.busy} onClick={onReplay}>
        {t("lipSyncReplay")}
      </Button>
      <Button variant="secondary" disabled={!comparison.playing} onClick={() => void comparison.togglePause()}>
        {t(comparison.paused ? "lipSyncResume" : "lipSyncPause")}
      </Button>
      <Button variant="secondary" disabled={!comparison.playing && !comparison.busy} onClick={onStop}>
        {t("stop")}
      </Button>
    </div>
  );
}

/** The test phrase, with its length against the cap. */
export function ScriptField({
  id,
  text,
  onChange,
  className,
}: {
  id: string;
  text: string;
  onChange: (text: string) => void;
  /** The box's height (min-h-*). */
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Field id={id} label={t("lipSyncScript")}>
      <Textarea className={className} value={text} maxLength={SCRIPT_MAX} onChange={(e) => onChange(e.target.value)} />
      <p className="mt-1 text-right text-xs text-gray-500">
        {text.length} / {SCRIPT_MAX}
      </p>
    </Field>
  );
}
