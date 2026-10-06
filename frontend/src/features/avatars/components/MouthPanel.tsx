import type { CharacterSettings } from "@liveface/embed/mouth";
import {
  DEFAULT_REFERENCE_PROFILE,
  normalizeProfile,
  PROFILE_LIMITS,
  type ReferenceProfile,
} from "@liveface/embed/mouth";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { FileInput } from "@/components/ui/FileInput";
import { Icon } from "@/components/ui/Icon";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Slider } from "@/components/ui/Slider";
import { Spinner } from "@/components/ui/Spinner";
import { useRadioGroup } from "@/components/ui/useRadioGroup";
import {
  useAvatarCache,
  usePublishAvatar,
  useRemoveMouthPhoto,
  useUpdateAvatar,
  useUploadMouthPhoto,
} from "@/features/avatars/api";
import { CharacterMouthSection } from "@/features/avatars/components/CharacterMouthSection";
import { JobProgressBar, ShapeTicks } from "@/features/avatars/components/create/JobProgress";
import { stageCount } from "@/features/avatars/creation";
import { useConsent } from "@/features/avatars/hooks/useConsent";
import { type KitEnding, useMouthKit } from "@/features/avatars/hooks/useMouthKit";
import type { MotionChoice } from "@/features/avatars/mouth-config";
import {
  canCompareShapes,
  droppedText,
  kitFailureText,
  kitTeethReason,
  kitTeethText,
  shapesLabel,
  shapesView,
  standardShapeText,
  teethNoteText,
} from "@/features/avatars/mouth-kit";
import { type MouthAction, mouthErrorKey, teethNoteKey, teethView } from "@/features/avatars/teeth";
import { ApiError } from "@/lib/api";
import { cx } from "@/lib/cx";
import type { Avatar, MouthRenderer } from "@/lib/types";

/** The photographic mouth paints human teeth; the server refuses it elsewhere. */
const rendererChoices = (avatar: Avatar): MouthRenderer[] =>
  (avatar.face_type ?? "human") === "human" ? ["classic", "continuous"] : ["classic"];

/** Lip projection belongs to the older geometric prototype only. */
const SLIDERS: (keyof ReferenceProfile)[] = ["teethScale", "teethY", "warmth", "jawRange"];
const LABELS: Record<keyof ReferenceProfile, string> = {
  teethScale: "mouthTeethSize",
  teethY: "mouthTeethPosition",
  warmth: "mouthWarmth",
  lipProjection: "mouthTeethSize",
  jawRange: "mouthJaw",
};

const MOTION_CHOICES: readonly MotionChoice[] = ["own", "standard"];

/** What changed in this visit that visitors do not see yet: the kit the
 * panel's job made, or a teeth photo the owner uploaded. */
type Changed = "kit" | "upload" | null;

/**
 * Which mouth this avatar speaks with, and how it is fitted.
 *
 * Every change here is a DRAFT edit, like framing or voice: the preview
 * updates at once, the Publish bar appears, and visitors see nothing until
 * the owner publishes. Sliders preview live through `onPreview` and are
 * saved when released, so dragging does not write on every tick.
 *
 * The photographic mouth says where its mouth shapes come from (made by AI
 * from the avatar's picture, all six or some of them with why the rest are
 * standard, or the standard ones) next to whose teeth it shows (the AI's
 * "ee", the owner's own photo, or standard ones with why). Its one AI
 * action makes the person's mouth shapes and teeth from this photo, what
 * step 5 of the wizard does, as a job it follows until it ends (useMouthKit),
 * on the member's third-party AI consent (asked once, useConsent.withAi);
 * teeth the owner uploaded are kept, so the action says it makes the shapes
 * only. What it made, or a teeth photo uploaded, is followed by a Publish
 * prompt beside it, since the bar that also offers it may be a long scroll
 * away. A compare switch plays the standard shapes in the preview instead
 * of the person's own (`motion`), so the same sentence can be heard both
 * ways; it changes nothing saved or published.
 */
export function MouthPanel({
  avatar,
  orgId,
  onPreview,
  onPreviewCharacter,
  motion,
  onMotion,
}: {
  avatar: Avatar;
  orgId: string;
  onPreview: (renderer: MouthRenderer, profile: ReferenceProfile) => void;
  /** An animation's or an animal's character settings being edited. */
  onPreviewCharacter: (settings: CharacterSettings | null) => void;
  /** The mouth shapes the dashboard preview plays (the compare switch). */
  motion: MotionChoice;
  onMotion: (choice: MotionChoice) => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const saved = avatar.mouth ?? null;
  const choices = rendererChoices(avatar);
  const savedRenderer: MouthRenderer = saved && choices.includes(saved.renderer) ? saved.renderer : "classic";
  const [renderer, setRenderer] = useState<MouthRenderer>(savedRenderer);
  const [profile, setProfile] = useState<ReferenceProfile>(() => normalizeProfile(saved?.profile));
  const [busy, setBusy] = useState(false);
  // The kit is being asked for (the consent dialog, the POST): not the wait.
  const [starting, setStarting] = useState(false);
  const [changed, setChanged] = useState<Changed>(null);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refused or failed mouth request is said beside its buttons, not under
  // the sliders: on a phone those are a screen apart.
  const [teethError, setTeethError] = useState<string | null>(null);
  const consent = useConsent(orgId);
  const cache = useAvatarCache(orgId, avatar.id);
  const update = useUpdateAvatar(orgId, avatar.id);
  const uploadPhoto = useUploadMouthPhoto(orgId, avatar.id);
  const removePhoto = useRemoveMouthPhoto(orgId, avatar.id);
  const publishAvatar = usePublishAvatar(orgId, avatar.id);
  const human = (avatar.face_type ?? "human") === "human";

  // Re-seed when the server's copy changes under us (publish, discard):
  // keyed by its content, not by the object a refetch replaces.
  const savedKey = JSON.stringify(saved);
  const seed = useRef({ renderer: savedRenderer, profile: saved?.profile });
  seed.current = { renderer: savedRenderer, profile: saved?.profile };
  useEffect(() => {
    setRenderer(seed.current.renderer);
    setProfile(normalizeProfile(seed.current.profile));
  }, [savedKey]);

  /** A refused mouth request in words: the panel's own for what it knows,
   * the server's sentence otherwise, and how long to wait when it said. */
  const refusal = (err: unknown, action: MouthAction) => {
    if (!(err instanceof ApiError)) return t("error");
    const key = mouthErrorKey(err.code, action);
    const text = key ? t(key) : err.detail || t("error");
    return err.retryAfter ? `${text} ${t("createRetryAfter", { count: err.retryAfter })}` : text;
  };

  /** How the kit job this tab followed ended: made (the avatar is fetched
   * again, and Publish offered beside it), or why not. */
  const ended = (ending: KitEnding) => {
    if (ending.kind === "done") {
      setTeethError(null);
      void cache.refresh().then(() => setChanged("kit"));
      return;
    }
    const failure = ending.kind === "interrupted" ? { code: "interrupted", detail: "" } : ending.error;
    setTeethError(kitFailureText(t, failure, (code) => mouthErrorKey(code, "generate"), ending.lastStage === "teeth"));
    // The switch was turned off meanwhile: the action gives way.
    if (failure.code === "third_party_ai_disabled") consent.refreshAiSwitch();
  };
  const kit = useMouthKit(orgId, avatar.id, avatar.kind === "photo" && human, ended);
  const running = kit.running;

  /** One teeth photo request (the avatar is fetched again after it);
   * resolves to its answer, or null when it failed (the error is shown). */
  const run = async <T,>(work: () => Promise<T>, action: MouthAction): Promise<T | null> => {
    setBusy(true);
    setTeethError(null);
    try {
      return await work();
    } catch (err) {
      setTeethError(refusal(err, action));
      return null;
    } finally {
      setBusy(false);
    }
  };

  /**
   * Settings saves merge the response into the cached avatar instead of
   * refetching (useUpdateAvatar): a refetch re-signs every asset URL and
   * the preview would rebuild, restarting the face mid-sentence, on every
   * slider release.
   */
  const save = async (nextRenderer: MouthRenderer, nextProfile: ReferenceProfile) => {
    setError(null);
    try {
      await update.mutateAsync({ body: { mouth: { renderer: nextRenderer, profile: nextProfile } } });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    }
  };

  const choose = (next: MouthRenderer) => {
    setRenderer(next);
    onPreview(next, profile);
    void save(next, profile);
  };
  // Classic or Photographic: one tab stop, the arrows choose.
  const rendererRadio = useRadioGroup(
    choices,
    renderer,
    (next) => {
      if (next !== renderer) choose(next);
    },
    () => busy
  );

  const slide = (key: keyof ReferenceProfile, value: number) => {
    const next = { ...profile, [key]: value };
    setProfile(next);
    onPreview(renderer, next);
  };

  const upload = (file: File | undefined) => {
    if (!file) return;
    void run(() => uploadPhoto.mutateAsync(file), "upload").then((done) => {
      if (done) setChanged("upload");
    });
  };

  const continuous = renderer === "continuous";
  const hasPhoto = Boolean(saved?.has_oral_photo);
  const teeth = teethView(saved);
  const aiTeeth = teeth?.kind === "ai";
  const ownTeeth = teeth?.kind === "upload";
  const note = teeth?.kind === "generic" ? teeth.note : null;
  const shapes = shapesView(saved);
  const standardShapes = shapes && shapes.kind !== "own" ? shapes.standard : [];
  const shapesDropped = shapes ? droppedText(t, shapes) : null;
  const teethReason = kitTeethReason(saved, teeth);
  const compare = canCompareShapes(saved);
  const actionKey = ownTeeth ? "mouthKitMakeShapes" : "mouthKitMake";
  // Offered while the organization allows third-party AI; the server
  // refuses otherwise anyway (and says so). Over the owner's own teeth
  // photo too: it is kept, and only the shapes are made.
  const canMakeKit = consent.aiEnabled && continuous && human;
  const working = running !== null;

  /**
   * The person's mouth shapes and teeth, made by AI from this avatar's
   * picture, what a new avatar gets when it is built: for one built before,
   * whose mouth could not be made then, or whose picture changed since. A
   * draft edit; the member's remembered consent is used, or asked for once
   * (useConsent.withAi), and "Not now" sends nothing.
   */
  const makeKit = async () => {
    setStarting(true);
    setTeethError(null);
    setChanged((now) => (now === "kit" ? null : now));
    try {
      await consent.withAi(t(actionKey), (consentId) => kit.start(consentId));
    } catch (err) {
      setTeethError(refusal(err, "generate"));
    } finally {
      setStarting(false);
    }
  };

  const publish = async () => {
    setPublishing(true);
    setTeethError(null);
    try {
      await publishAvatar.mutateAsync();
      setChanged(null);
    } catch (err) {
      setTeethError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setPublishing(false);
    }
  };

  // Where the running job is, in words: queued, its stage (the shapes
  // counted), or nothing known beyond that it runs.
  const stage = kit.stage;
  const count = stage === "shapes" ? stageCount(running) : null;
  // The shapes come with the teeth photo, unless the owner's own is kept.
  const stageKey = stage === "shapes" && !ownTeeth ? "mouthKitStage_shapesTeeth" : `mouthKitStage_${stage}`;
  const progressText = !running
    ? ""
    : running.state === "queued"
      ? t("createJobQueued")
      : stage
        ? t(stageKey)
        : t("mouthKitWorking");
  const progressSpoken = count
    ? `${progressText} ${t("mouthShapesCount", { done: count.done, total: count.total })}`
    : progressText;
  // Until the draft with the new mouth is live.
  const promptPublish = changed !== null && (avatar.unpublished === true || !avatar.published);
  const madeText =
    changed === "upload"
      ? t("mouthTeethMade")
      : saved?.kit?.state === "made"
        ? t(saved.kit.teeth?.used ? "mouthKitMadeTeeth" : "mouthKitMade")
        : t("mouthTeethMade");
  // One region, always mounted, says what happens to the mouth: a region
  // mounted with its text is not reliably read out.
  const spoken = running ? progressSpoken : promptPublish ? madeText : "";

  // Scrolled to from the finish notice: it stops below the sticky header
  // (and, from lg, the sticky page head) rather than under them.
  // Scrolled to from the finish notice: it stops below the sticky header
  // (and, from lg, the sticky page head) rather than under them.
  return (
    <section
      id="mouth-panel"
      tabIndex={-1}
      className={cx(
        "space-y-4 outline-none",
        "scroll-mt-[calc(3.5rem+env(safe-area-inset-top)+1rem)]",
        "lg:scroll-mt-[calc(3.5rem+env(safe-area-inset-top)+var(--head-h,0px)+1rem)]"
      )}
      aria-label={t("mouthTitle")}
    >
      <div>
        <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t("mouthHint")}</p>
      </div>

      {!human && avatar.kind === "photo" && (
        <CharacterMouthSection avatar={avatar} orgId={orgId} onPreview={onPreviewCharacter} />
      )}

      <div
        className={cx(
          "grid gap-2",
          choices.length === 1 ? "grid-cols-1" : "grid-cols-2",
          !human && avatar.kind === "photo" && "hidden"
        )}
        role="radiogroup"
        aria-label={t("mouthTitle")}
      >
        {choices.map((option) => (
          <ChoiceCard key={option} selected={renderer === option} disabled={busy} {...rendererRadio(option)}>
            {t(option === "classic" ? "mouthClassic" : "mouthContinuous")}
            <span className="mt-0.5 block text-xs font-normal text-gray-500">
              {t(option === "classic" ? "mouthClassicHint" : "mouthContinuousHint")}
            </span>
          </ChoiceCard>
        ))}
      </div>

      {choices.length === 1 && <p className="text-xs leading-relaxed text-gray-500">{t("mouthHumanOnly")}</p>}

      {continuous && (
        <>
          <div
            className="divide-y divide-black/[0.06] rounded-xl bg-black/[0.03] dark:divide-white/[0.06] dark:bg-white/[0.04]"
            id="mouth-teeth"
          >
            {shapes && (
              <div className="p-3">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {t("mouthShapesInUse")}
                  <SourceChip made={shapes.kind !== "standard"}>{shapesLabel(t, shapes)}</SourceChip>
                </p>
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  {shapesDropped ??
                    t(
                      shapes.kind === "standard"
                        ? "mouthShapesStandardHint"
                        : shapes.kind === "mixed"
                          ? "mouthShapesAiHintMixed"
                          : "mouthShapesAiHint"
                    )}
                </p>
                {standardShapes.length > 0 && (
                  <div className="mt-1.5 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
                    <p className="font-medium">{t("mouthShapesWhy")}</p>
                    <ul className="mt-0.5 list-disc space-y-0.5 ps-4">
                      {standardShapes.map((shape) => (
                        <li key={shape.shape}>{standardShapeText(t, shape)}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {compare && (
                  <div className="mt-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span id="mouth-compare-label" className="text-xs font-medium text-gray-600 dark:text-gray-300">
                        {t("mouthCompare")}
                      </span>
                      <SegmentedControl
                        look="pill"
                        labelledBy="mouth-compare-label"
                        describedBy="mouth-compare-hint"
                        options={MOTION_CHOICES.map((choice) => ({
                          value: choice,
                          label: t(`mouthCompare_${choice}`),
                        }))}
                        value={motion}
                        onChange={(choice) => motion !== choice && onMotion(choice)}
                      />
                    </div>
                    <p id="mouth-compare-hint" className="mt-1.5 text-xs leading-relaxed text-gray-500">
                      {t("mouthCompareHint")}
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="p-3">
              {teeth && (
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {t("mouthTeethInUse")}
                  <SourceChip made={teeth.kind !== "generic"} ai={teeth.kind === "ai"}>
                    {t(`mouthTeethKind_${teeth.kind}`)}
                  </SourceChip>
                </p>
              )}
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                {t(aiTeeth ? "mouthTeethAiHint" : hasPhoto ? "mouthPhotoActive" : "mouthPhotoHint")}
              </p>
              {note && (
                <p className="mt-1.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                  {teethNoteText(t, note, teethNoteKey)}
                </p>
              )}
              {teethReason && (
                <p className="mt-1.5 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
                  {kitTeethText(t, teethReason)}
                </p>
              )}
            </div>

            <div className="p-3">
              {canMakeKit && (
                <>
                  {/* Held with aria-disabled, not disabled, while the job is
                      asked for and runs (up to a minute): a disabled button
                      drops the keyboard's focus to the page, and the next
                      Tab would start from the top. */}
                  <Button
                    variant="secondary"
                    size="lg"
                    className="max-w-full text-start aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
                    icon={
                      starting || working ? (
                        <Spinner className="h-4 w-4 shrink-0" />
                      ) : (
                        <Icon name="sparkles" className="h-4 w-4 shrink-0" />
                      )
                    }
                    disabled={busy}
                    aria-disabled={starting || working}
                    onClick={() => {
                      if (!starting && !working) void makeKit();
                    }}
                    aria-describedby="mouth-kit-hint"
                  >
                    {t(actionKey)}
                  </Button>
                  <p id="mouth-kit-hint" className="mt-1.5 text-xs leading-relaxed text-gray-500">
                    {t(ownTeeth ? "mouthKitHintShapes" : "mouthKitHint")}
                  </p>
                </>
              )}
              {running && (
                <div className="mt-2.5 rounded-lg border border-black/10 bg-white p-2.5 dark:border-white/10 dark:bg-panel">
                  <p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs font-medium">
                    <span className="flex items-center gap-2">
                      <Spinner className="h-3.5 w-3.5 shrink-0 text-brand-600" />
                      {progressText}
                    </span>
                    {count && (
                      <span className="tabular-nums text-brand-700 dark:text-brand-300">
                        {t("mouthShapesCount", { done: count.done, total: count.total })}
                      </span>
                    )}
                  </p>
                  {count && <ShapeTicks count={count} />}
                  <JobProgressBar fraction={running.progress?.fraction ?? null} label={progressText} />
                </div>
              )}
              <div className={cx("flex flex-wrap gap-2", (canMakeKit || running) && "mt-2.5")}>
                <FileInput
                  ref={fileRef}
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(event) => {
                    upload(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                <Button
                  variant="secondary"
                  size="lg"
                  loading={busy}
                  disabled={working}
                  onClick={() => fileRef.current?.click()}
                >
                  {t(ownTeeth ? "mouthPhotoReplace" : "mouthPhotoAdd")}
                </Button>
                {hasPhoto && (
                  <Button
                    variant="secondary"
                    size="lg"
                    disabled={busy || working}
                    onClick={() => void run(() => removePhoto.mutateAsync(), "upload")}
                  >
                    {t("mouthPhotoRemove")}
                  </Button>
                )}
              </div>
              {teethError && (
                <p className="field-error mt-2.5 text-xs leading-relaxed" role="alert">
                  {teethError}
                </p>
              )}
              {promptPublish && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/70 p-2.5 dark:border-amber-500/40">
                  <p className="min-w-0 flex-1 text-xs leading-relaxed text-gray-700 dark:text-gray-200">{madeText}</p>
                  <Button size="lg" loading={publishing} disabled={busy || working} onClick={() => void publish()}>
                    {t("publish")}
                  </Button>
                </div>
              )}
            </div>
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {spoken}
          </p>

          {SLIDERS.map((key) => {
            const [min, max, step] = PROFILE_LIMITS[key];
            return (
              <Slider
                key={key}
                id={`mouth-${key}`}
                label={t(LABELS[key])}
                min={min}
                max={max}
                step={step}
                value={profile[key]}
                onChange={(value) => slide(key, value)}
                // Saved on release, not per tick: each save is a draft edit.
                onPointerUp={() => void save(renderer, profile)}
                onKeyUp={() => void save(renderer, profile)}
              />
            );
          })}
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              const reset = { ...DEFAULT_REFERENCE_PROFILE };
              setProfile(reset);
              onPreview(renderer, reset);
              void save(renderer, reset);
            }}
          >
            {t("mouthReset")}
          </Button>
        </>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {consent.dialog}
    </section>
  );
}

/** Where a part of the mouth comes from, as a badge: this photo's (made by
 * AI, with its mark; or the owner's own photo), or standard. */
function SourceChip({ made, ai = made, children }: { made: boolean; ai?: boolean; children: ReactNode }) {
  return (
    <Badge tone={made ? "brand" : "muted"} icon={ai ? "sparkles" : undefined}>
      {children}
    </Badge>
  );
}
