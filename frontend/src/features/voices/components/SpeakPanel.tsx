import { type SpeechPlayer, sttSupported } from "@liveface/embed";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { FieldError } from "@/components/ui/FieldError";
import { Textarea } from "@/components/ui/Textarea";
import { clonedVoiceName, type RenderLineRequest } from "@/features/voices/clonedLines";
import { VoicePicker, type VoiceSelection } from "@/features/voices/components/VoicePicker";
import { useSpeakPanel } from "@/features/voices/hooks/useSpeakPanel";
import { useT } from "@/i18n";

/** At most this many rendered lines offered at once: a row or two, not a list. */
const PICKS = 6;

/**
 * A voice, a line, and Speak: the line said by the engine it is given, in
 * that voice (useSpeakPanel holds the words, the voice and the playing).
 * Stop ends it; the microphone fills the box where the browser can listen.
 * A cloned voice shows what it can say (the lines rendered in it, to pick);
 * a line it was never given is said so, with the two ways on: hear it in a
 * server voice now, or have it rendered on the Voices page.
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
  const failure = panel.failure;
  const render: RenderLineRequest = { voice: clonedVoiceName(panel.selection.voice), line: panel.text.trim() };

  return (
    <Card as="section" className="flex flex-col gap-4" aria-label={title}>
      {title && (
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
          {hint && <p className="mt-0.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{hint}</p>}
        </div>
      )}
      <VoicePicker value={panel.selection} onChange={panel.setSelection} />
      {panel.cloned && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="w-full text-xs text-gray-500 dark:text-gray-400">{t("speakClonedHint")}</p>
          {panel.renderedLines.length ? (
            <ul aria-label={t("speakClonedLines")} className="flex min-w-0 flex-wrap gap-2">
              {panel.renderedLines.slice(0, PICKS).map((rendered) => (
                <li key={rendered} className="min-w-0 max-w-full">
                  <Chip
                    variant="suggestion"
                    className="max-w-full truncate"
                    title={rendered}
                    onClick={() => panel.setText(rendered)}
                  >
                    {rendered}
                  </Chip>
                </li>
              ))}
            </ul>
          ) : (
            <ButtonLink variant="link" size="sm" to="/voices">
              {t("speakClonedAddLines")}
            </ButtonLink>
          )}
        </div>
      )}
      <Textarea
        aria-label={t("speakPlaceholder")}
        className="min-h-24"
        placeholder={t("speakPlaceholder")}
        value={panel.text}
        onChange={(e) => panel.setText(e.target.value)}
      />
      {failure?.code === "cloned_line_missing" ? (
        <Banner
          appearance="soft"
          tone="warning"
          icon="alert"
          role="alert"
          actions={
            <>
              <Button
                size="sm"
                variant="secondary"
                icon="speaker"
                disabled={!engine || panel.busy}
                onClick={panel.speakInServerVoice}
              >
                {t("speakUseServerVoice")}
              </Button>
              <ButtonLink size="sm" variant="secondary" icon="mic" to="/voices" state={render}>
                {t("speakRecordLine")}
              </ButtonLink>
            </>
          }
        >
          {failure.text}
        </Banner>
      ) : (
        failure && <FieldError>{failure.text}</FieldError>
      )}
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
