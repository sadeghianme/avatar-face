import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Chip } from "@/components/ui/Chip";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { DropZone } from "@/components/ui/DropZone";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { Textarea } from "@/components/ui/Textarea";
import { useRadioGroup } from "@/components/ui/useRadioGroup";
import { AiConsentReagreeNote } from "@/features/avatars/components/create/AiConsentDialog";
import { LookPicture, PICTURE_BACKDROP } from "@/features/avatars/components/wizard/Art";
import { BackButton, PhoneNote, StepFooter } from "@/features/avatars/components/wizard/Footer";
import { CONSENT_TEXT_VERSIONS, consentProblem, type FaceStatement, providerLabel } from "@/features/avatars/consent";
import { ACCEPTED_TYPES, checkFile, type Creation, type DraftStore, errorText } from "@/features/avatars/creation";
import type { ConsentApi } from "@/features/avatars/hooks/useConsent";
import {
  aiRequired,
  type AvatarModel,
  type Choices,
  intentFor,
  type Look,
  LOOKS,
  MAX_WORDS,
  photoBlocker,
  type PhotoSource,
  rememberChoices,
  SOURCES,
  statementFor,
} from "@/features/avatars/wizard";
import { api, ApiError, postFormWithProgress } from "@/lib/api";
import { cx } from "@/lib/cx";

const EXAMPLES = [1, 2, 3, 4] as const;

/** Generate / Upload: two halves of one grey bar, the chosen one raised. */
const SOURCE_TAB = cx(
  "flex min-h-14 items-center justify-center gap-2.5 rounded-xl px-3 py-2.5 text-start transition",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
);
const SOURCE_TAB_ON = "bg-white shadow-sm ring-1 ring-black/5 dark:bg-raised dark:ring-white/10";
const SOURCE_TAB_OFF = "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white";

/** A look: its picture over its name, ringed when chosen. */
const LOOK_CARD = cx(
  "group relative flex flex-col overflow-hidden rounded-2xl border bg-white text-start transition dark:bg-raised",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-ink",
  "disabled:cursor-not-allowed disabled:opacity-45"
);
const LOOK_CARD_ON = "border-brand-500 ring-1 ring-brand-500";
const LOOK_CARD_OFF = "border-gray-200 hover:border-brand-300 dark:border-line dark:hover:border-brand-500/40";

function tabStore(): DraftStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Step 2: the face. "Generate with AI" (one description, a few example
 * chips) or "Upload a photo", then the look (Realistic, Animation,
 * Cartoon), each shown as a small picture. The agreement to send the
 * photo or the description to the AI, and for a person the statement
 * about the face, are asked here, on this screen, never later as a
 * pop-up; the button says what it is waiting for.
 *
 * "Create my avatar" records the AI agreement (unless the member already
 * agreed to the words in force), sends the photo or the description, and
 * records the statement for the creation that came back, so publishing
 * asks nothing again. A realistic upload may go without the AI: its photo
 * is then used as it is, cut out.
 */
export function PhotoStep({
  orgId,
  model,
  consent,
  initial,
  onBack,
  onCreated,
}: {
  orgId: string;
  model: AvatarModel;
  consent: ConsentApi;
  /** Coming Back from step 3: the choices made then. */
  initial: Choices | null;
  onBack: () => void;
  onCreated: (creation: Creation) => void;
}) {
  const { t } = useTranslation();
  const aiEnabled = consent.aiEnabled;
  const [source, setSource] = useState<PhotoSource>(initial?.source ?? (aiEnabled ? "generate" : "upload"));
  const [look, setLook] = useState<Look>(initial?.look ?? "realistic");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const remembered = typeof consent.aiConsentId === "string";
  const [aiAgreed, setAiAgreed] = useState(remembered);
  const [statementAgreed, setStatementAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const describe = useRef<HTMLTextAreaElement>(null);
  const ids = useId();

  // A remembered agreement arrives after the first render: shown ticked.
  useEffect(() => {
    if (remembered) setAiAgreed(true);
  }, [remembered]);

  // The object URL is a real allocation: dropped when replaced.
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview]
  );

  // Without the AI, a character cannot be generated.
  useEffect(() => {
    if (!aiEnabled && source === "generate") setSource("upload");
  }, [aiEnabled, source]);

  const statement = statementFor(model, source);
  const needsAi = aiRequired(source, look);
  const blocker = photoBlocker({
    model,
    source,
    look,
    description,
    hasFile: Boolean(file),
    aiAgreed,
    statementAgreed,
    aiEnabled,
  });

  const choose = (next: File | undefined) => {
    setFileError(null);
    if (!next) return;
    const problem = checkFile(next);
    if (problem) {
      setFileError(errorText(t, problem, ""));
      return;
    }
    setFile(next);
    setPreview(URL.createObjectURL(next));
  };

  const agreement = async (): Promise<string | undefined> => {
    if (!aiAgreed || !aiEnabled) return undefined;
    if (typeof consent.aiConsentId === "string") return consent.aiConsentId;
    return (await consent.record("third_party_ai")).id;
  };

  const send = async (consentId: string | undefined): Promise<Creation> => {
    if (source === "upload" && file) {
      const form = new FormData();
      form.append("file", file);
      form.append("model", model);
      form.append("look", look);
      setProgress(0);
      return postFormWithProgress<Creation>(`/orgs/${orgId}/creations`, form, setProgress);
    }
    return api.post<Creation>(`/orgs/${orgId}/creations/generate`, {
      model,
      look,
      prompt: description.trim(),
      ...(consentId ? { consent_id: consentId } : {}),
    });
  };

  const start = async () => {
    if (blocker || busy) return;
    setBusy(true);
    setError(null);
    try {
      let consentId = await agreement();
      let created: Creation;
      try {
        created = await send(consentId);
      } catch (err) {
        // A remembered agreement the server no longer takes (withdrawn,
        // or the words changed since): agreed again on this screen, where
        // the box is ticked, and sent once more.
        const problem = err instanceof ApiError ? consentProblem(err.code, err.body) : null;
        if (problem?.kind !== "required" || problem.scope !== "third_party_ai" || !consentId) throw err;
        consent.forgetAi();
        consentId = (await consent.record("third_party_ai")).id;
        created = await send(consentId);
      }
      let made: FaceStatement | null = null;
      if (statement) {
        try {
          await consent.record(statement, created.id);
          made = statement;
        } catch {
          // Publish asks again when it finds none; nothing is lost here.
        }
      }
      rememberChoices(tabStore(), created.id, {
        model,
        source,
        look,
        description,
        intent: intentFor({ source, look, aiAgreed, aiEnabled }),
        statement: made,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? errorText(t, err.code, err.detail, err.retryAfter) : t("error"));
      setBusy(false);
      setProgress(null);
    }
  };

  const sourceRadio = useRadioGroup(SOURCES, source, setSource, (s) => s === "generate" && !aiEnabled);
  const lookDisabled = (l: Look) => !aiEnabled && aiRequired(source, l);
  const lookRadio = useRadioGroup(LOOKS, look, setLook, lookDisabled);
  const providers = consent.providers.map(providerLabel).join(", ");

  return (
    <div className="space-y-7">
      <div className="grid gap-7 lg:grid-cols-2 lg:gap-12 xl:gap-16">
        <div className="space-y-7">
          {/* How to start */}
          <div>
            <p id={`${ids}-source`} className="sr-only">
              {t("wzSourceLabel")}
            </p>
            <div
              role="radiogroup"
              aria-labelledby={`${ids}-source`}
              className="grid grid-cols-2 gap-1.5 rounded-2xl bg-gray-100 p-1.5 dark:bg-white/[0.05]"
            >
              {SOURCES.map((s) => {
                const disabled = s === "generate" && !aiEnabled;
                const on = s === source;
                return (
                  <ChoiceCard
                    key={s}
                    look="custom"
                    {...sourceRadio(s)}
                    disabled={disabled}
                    className={cx(SOURCE_TAB, on ? SOURCE_TAB_ON : SOURCE_TAB_OFF)}
                  >
                    <span
                      aria-hidden="true"
                      className={cx(
                        "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
                        on
                          ? "bg-brand-600 text-white"
                          : "bg-white text-gray-500 dark:bg-white/[0.06] dark:text-gray-400"
                      )}
                    >
                      <Icon
                        name={s === "generate" ? "sparkles" : "upload"}
                        className="h-[18px] w-[18px]"
                        strokeWidth={1.9}
                      />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold leading-tight">{t(`wzSource_${s}`)}</span>
                      <span className="hidden text-xs text-gray-500 sm:block dark:text-gray-400">
                        {disabled ? t("wzAiOffBadge") : t(`wzSourceHint_${s}`)}
                      </span>
                    </span>
                  </ChoiceCard>
                );
              })}
            </div>
            {!aiEnabled && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t("wzAiOffGenerate")}</p>}
          </div>

          {source === "generate" ? (
            <div>
              <Field id={`${ids}-describe`} label={t(`wzDescribeLabel_${model}`)}>
                <div className="relative">
                  <Textarea
                    ref={describe}
                    rows={3}
                    maxLength={MAX_WORDS}
                    className="min-h-[96px] resize-none pb-7 text-[15px] leading-relaxed"
                    placeholder={t(`wzDescribePlaceholder_${model}`)}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    aria-describedby={`${ids}-count`}
                    disabled={busy}
                  />
                  <span
                    id={`${ids}-count`}
                    className="pointer-events-none absolute bottom-2 end-3 text-[11px] tabular-nums text-gray-400"
                  >
                    {t("wzCharCount", { count: description.length, max: MAX_WORDS })}
                  </span>
                </div>
              </Field>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{t("wzTry")}</span>
                {EXAMPLES.map((n) => {
                  const text = t(`wzExample_${model}_${n}`);
                  return (
                    <Chip
                      key={n}
                      variant="suggestion"
                      disabled={busy}
                      onClick={() => {
                        setDescription(text);
                        describe.current?.focus();
                      }}
                    >
                      {text}
                    </Chip>
                  );
                })}
              </div>
            </div>
          ) : (
            <PhotoDrop
              model={model}
              file={file}
              preview={preview}
              error={fileError}
              busy={busy}
              onChoose={choose}
              onClear={() => {
                setFile(null);
                setPreview(null);
              }}
            />
          )}
        </div>

        <div className="space-y-7">
          {/* The look */}
          <div>
            <p id={`${ids}-look`} className="label">
              {t("wzLookLabel")}
            </p>
            <div role="radiogroup" aria-labelledby={`${ids}-look`} className="grid grid-cols-3 gap-2.5 sm:gap-4">
              {LOOKS.map((l) => {
                const on = l === look;
                const disabled = lookDisabled(l);
                return (
                  <ChoiceCard
                    key={l}
                    look="custom"
                    {...lookRadio(l)}
                    disabled={disabled || busy}
                    aria-describedby={`${ids}-look-${l}`}
                    className={cx(LOOK_CARD, on ? LOOK_CARD_ON : LOOK_CARD_OFF)}
                  >
                    <span className={cx("relative block aspect-square w-full overflow-hidden", PICTURE_BACKDROP)}>
                      <LookPicture model={model} look={l} className="absolute inset-0 h-full w-full" />
                      {on && (
                        <span className="absolute end-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-brand-600 text-white shadow motion-safe:animate-tick-in">
                          <Icon name="check" className="h-3.5 w-3.5" strokeWidth={2.6} />
                        </span>
                      )}
                    </span>
                    <span className="px-2.5 py-2 sm:px-3.5 sm:py-3">
                      <span className="block text-sm font-semibold">{t(`wzLook_${l}`)}</span>
                      <span
                        id={`${ids}-look-${l}`}
                        className="mt-0.5 hidden text-xs leading-snug text-gray-500 sm:block dark:text-gray-400"
                      >
                        {disabled
                          ? t("wzAiOffBadge")
                          : t(source === "upload" ? `wzLookUploadHint_${l}` : `wzLookHint_${l}`)}
                      </span>
                    </span>
                  </ChoiceCard>
                );
              })}
            </div>
          </div>

          {/* Agreements, here and only here */}
          {(aiEnabled || statement) && (
            <div className="space-y-3 rounded-2xl border border-gray-200 bg-gray-50/70 p-4 dark:border-line dark:bg-white/[0.03]">
              {aiEnabled && (
                <div>
                  <Checkbox
                    size="md"
                    className="text-gray-800 dark:text-gray-200"
                    checked={aiAgreed}
                    disabled={busy}
                    onChange={(e) => setAiAgreed(e.target.checked)}
                    aria-describedby={`${ids}-ai-more`}
                    label={<span>{t(source === "upload" ? "wzConsentAi_upload" : "wzConsentAi_generate")}</span>}
                  />
                  <div id={`${ids}-ai-more`} className="ms-8 mt-1 space-y-1 text-xs text-gray-500 dark:text-gray-400">
                    {consent.aiReagree && <AiConsentReagreeNote className="!text-xs font-medium" />}
                    <p>
                      {t("wzConsentAiProvider", { providers })} {!needsAi && t("wzConsentOptional")}
                    </p>
                    <details className="group">
                      <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium text-brand-700 hover:underline coarse:min-h-11 dark:text-brand-300">
                        <Icon
                          name="chevron"
                          className="h-3.5 w-3.5 transition-transform group-open:rotate-90 rtl:-scale-x-100"
                        />
                        {t("wzConsentDetails")}
                      </summary>
                      <div className="mt-2 space-y-2 leading-relaxed">
                        <p>{t("aiConsentSent", { providers })}</p>
                        <p>{t("aiConsentKept")}</p>
                        <p>{t("aiConsentRights")}</p>
                        <p className="text-[11px]">
                          {t("aiConsentRecorded", { version: CONSENT_TEXT_VERSIONS.third_party_ai })}
                        </p>
                      </div>
                    </details>
                  </div>
                </div>
              )}
              {statement && (
                <Checkbox
                  size="md"
                  className="text-gray-800 dark:text-gray-200"
                  checked={statementAgreed}
                  disabled={busy}
                  onChange={(e) => setStatementAgreed(e.target.checked)}
                  label={
                    <span>
                      {t(statement === "depiction" ? "createDepictionStatement" : "createGeneratedFaceStatement")}
                    </span>
                  }
                />
              )}
            </div>
          )}
        </div>
      </div>

      {error && (
        <Banner appearance="soft" tone="danger" role="alert">
          {error}
        </Banner>
      )}

      {blocker && !busy && <PhoneNote id={`${ids}-hold`}>{t(blocker)}</PhoneNote>}

      <StepFooter back={<BackButton onClick={onBack} disabled={busy} />} note={blocker && !busy ? t(blocker) : null}>
        <Button
          size="xl"
          className="shadow-sm shadow-brand-600/20 sm:px-6"
          icon={<Icon name="sparkles" className="h-4 w-4" strokeWidth={1.9} />}
          loading={busy}
          onClick={() => void start()}
          disabled={Boolean(blocker)}
          aria-describedby={blocker ? `${ids}-hold` : undefined}
        >
          {busy
            ? progress !== null && progress < 1
              ? t("wzUploading", { percent: Math.round(progress * 100) })
              : t("wzStarting")
            : t("wzCreate")}
        </Button>
      </StepFooter>
    </div>
  );
}

function PhotoDrop({
  model,
  file,
  preview,
  error,
  busy,
  onChoose,
  onClear,
}: {
  model: AvatarModel;
  file: File | null;
  preview: string | null;
  error: string | null;
  busy: boolean;
  onChoose: (file: File | undefined) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const ids = useId();

  if (file && preview) {
    return (
      <div>
        <p className="label">{t("wzDropLabel")}</p>
        <div className="flex items-center gap-4 rounded-2xl border border-gray-200 bg-white p-3 dark:border-line dark:bg-raised">
          <img src={preview} alt="" className="h-20 w-20 shrink-0 rounded-xl object-cover sm:h-24 sm:w-24" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{file.name}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{(file.size / (1024 * 1024)).toFixed(1)} MB</p>
            <Button
              variant="link"
              className="mt-2 text-start text-sm"
              onClick={() => input.current?.click()}
              disabled={busy}
            >
              {t("wzChangePhoto")}
            </Button>
          </div>
          <IconButton
            variant="plain"
            label={t("wzRemovePhoto")}
            tooltip
            icon="close"
            iconClassName="h-5 w-5"
            className="h-11 w-11 rounded-full hover:bg-gray-100 dark:hover:bg-white/[0.06]"
            onClick={onClear}
            disabled={busy}
          />
          <FileInput
            ref={input}
            srOnly
            tabIndex={-1}
            aria-hidden="true"
            accept={ACCEPTED_TYPES.join(",")}
            onChange={(e) => {
              onChoose(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <p id={`${ids}-label`} className="label">
        {t("wzDropLabel")}
      </p>
      <DropZone
        labelledBy={`${ids}-label`}
        title={t("wzDrop")}
        hint={t(`wzDropHint_${model}`)}
        accept={ACCEPTED_TYPES.join(",")}
        disabled={busy}
        onFile={onChoose}
      />
      {error && (
        <p role="alert" className="field-error text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
