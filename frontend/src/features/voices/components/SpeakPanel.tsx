import { type SpeechPlayer, sttSupported } from "@liveface/embed";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FieldError } from "@/components/ui/FieldError";
import { Textarea } from "@/components/ui/Textarea";
import { VoicePicker, type VoiceSelection } from "@/features/voices/components/VoicePicker";
import { useSpeakPanel } from "@/features/voices/hooks/useSpeakPanel";
import { useT } from "@/i18n";

/**
 * A voice, a line, and Speak: the line said by the engine it is given, in
 * that voice (useSpeakPanel holds the words, the voice and the playing).
 * Stop ends it; the microphone fills the box where the browser can listen.
 */
export function SpeakPanel({
  engine,
  orgId,
  selection,
  onSelectionChange,
  title,
  hint,
}: {
  engine: SpeechPlayer | null;
  orgId: string;
  /** Controlled when supplied — the avatar page owns it so the embed snippet
   *  can reproduce the voice that was tested. Standalone callers omit both. */
  selection?: VoiceSelection;
  onSelectionChange?: (selection: VoiceSelection) => void;
  /** A heading for the card, where it is one section among others (the
   *  avatar page); with a line under it when given. */
  title?: string;
  hint?: string;
}) {
  const { t } = useT();
  const panel = useSpeakPanel({ engine, orgId, selection, onSelectionChange });

  return (
    <Card as="section" className="flex flex-col gap-4" aria-label={title}>
      {title && (
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
          {hint && <p className="mt-0.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{hint}</p>}
        </div>
      )}
      <VoicePicker value={panel.selection} onChange={panel.setSelection} />
      <Textarea
        aria-label={t("speakPlaceholder")}
        className="min-h-24"
        placeholder={t("speakPlaceholder")}
        value={panel.text}
        onChange={(e) => panel.setText(e.target.value)}
      />
      {panel.error && <FieldError>{panel.error}</FieldError>}
      <div className="flex gap-2">
        <Button
          size="lg"
          icon="speaker"
          className="flex-1"
          disabled={!engine || !panel.text.trim() || panel.busy}
          onClick={panel.speak}
        >
          {t("speak")}
        </Button>
        <Button variant="secondary" size="lg" icon="stop" disabled={!engine} onClick={panel.stop}>
          {t("stop")}
        </Button>
        {sttSupported() && (
          <Button
            variant="secondary"
            size="lg"
            className="min-w-11"
            icon={panel.listening ? "ear" : "mic"}
            disabled={panel.listening}
            onClick={panel.dictate}
            title={t("dictate")}
            aria-label={t("dictate")}
          />
        )}
      </div>
    </Card>
  );
}
