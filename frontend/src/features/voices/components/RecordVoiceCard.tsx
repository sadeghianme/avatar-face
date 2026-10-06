import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { FieldError } from "@/components/ui/FieldError";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { MIN_REFERENCE_SECONDS, type VoicesPageState } from "@/features/voices/hooks/useVoicesPage";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";

/** Record a reference voice, name it, give its lines and the speaker's
 *  permission, and queue the clone. */
export function RecordVoiceCard({ page }: { page: VoicesPageState }) {
  const { t } = useT();
  const { recording, elapsed, reference } = page.recorder;
  return (
    <Card as="section">
      <CardHeader
        className="mb-3"
        title={t("voicesRecordTitle")}
        description={t("voicesRecordHint", { seconds: MIN_REFERENCE_SECONDS })}
      />
      {/* Something to read: covers varied phonemes without feeling like a test. */}
      <blockquote className="mb-4 rounded-lg border-s-4 border-brand-300 bg-gray-50 p-3 text-sm italic dark:border-brand-500/40 dark:bg-white/5">
        {t("voicesPassage")}
      </blockquote>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={recording ? "danger" : "primary"}
          icon={recording ? "stop" : "mic"}
          onClick={page.recorder.toggle}
        >
          {recording ? t("voicesStop") : t("voicesRecord")}
        </Button>
        {recording && <span className="text-sm tabular-nums text-gray-500">{elapsed.toFixed(0)}s</span>}
        {reference && !recording && (
          <>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- the member's own voice, just recorded: there is no text to caption */}
            <audio controls src={reference.url} className="h-9 max-w-52" />
            <span
              className={cx("text-xs", reference.seconds < MIN_REFERENCE_SECONDS ? "text-amber-600" : "text-gray-500")}
            >
              {reference.seconds.toFixed(1)}s{reference.seconds < MIN_REFERENCE_SECONDS && ` — ${t("voicesTooShort")}`}
            </span>
          </>
        )}
      </div>

      <Field id="voice-name" label={t("voicesName")} className="mt-5">
        <Input value={page.form.name} onChange={(e) => page.setName(e.target.value)} placeholder="my-voice" />
      </Field>

      <Field id="voice-lines" label={t("voicesLines")} hint={t("voicesLinesHint")} className="mt-4">
        <Textarea
          className="min-h-28 font-mono text-xs coarse:text-base"
          value={page.form.lines}
          onChange={(e) => page.setLines(e.target.value)}
        />
      </Field>

      <Checkbox
        className="mt-4 gap-2 text-[13px] max-lg:text-sm"
        checked={page.form.consent}
        onChange={(e) => page.setConsent(e.target.checked)}
        label={t("voicesConsent")}
      />

      <Button className="mt-4" icon="plus" loading={page.sending} disabled={!page.canSubmit} onClick={page.send}>
        {t("voicesSubmit")}
      </Button>
      {page.error && <FieldError className="mt-2">{page.error}</FieldError>}
    </Card>
  );
}
