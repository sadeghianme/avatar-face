import type { CharacterSettings, ReferenceProfile } from "@liveface/embed/mouth";

import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { FieldError } from "@/components/ui/FieldError";
import { CharacterMouthSection } from "@/features/avatars/components/CharacterMouthSection";
import { MouthKitActions } from "@/features/avatars/components/mouth/MouthKitActions";
import { MouthSliders } from "@/features/avatars/components/mouth/MouthSliders";
import { MouthShapes, MouthTeeth } from "@/features/avatars/components/mouth/MouthSources";
import { useMouthPanel } from "@/features/avatars/hooks/useMouthPanel";
import type { MotionChoice } from "@/features/avatars/mouth-config";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";
import type { Avatar, MouthRenderer } from "@/lib/types";

/**
 * Which mouth this avatar speaks with, and how it is fitted. The state and
 * the requests are useMouthPanel's; this draws them.
 *
 * Every change here is a DRAFT edit, like framing or voice: the preview
 * updates at once, the Publish bar appears, and visitors see nothing until
 * the owner publishes. Sliders preview live through `onPreview` and are
 * saved when released, so dragging does not write on every tick.
 *
 * The photographic mouth says where its mouth shapes come from (made by AI
 * from the avatar's picture, all six or some of them with why the rest are
 * standard, or the standard ones; MouthShapes) next to whose teeth it shows
 * (the AI's "ee", the owner's own photo, or standard ones with why;
 * MouthTeeth). Its one AI action makes the person's mouth shapes and teeth
 * from this photo, what step 5 of the wizard does, as a job it follows
 * until it ends (useMouthKit), on the member's third-party AI consent
 * (asked once, useConsent.withAi); teeth the owner uploaded are kept, so
 * the action says it makes the shapes only. What it made, or a teeth photo
 * uploaded, is followed by a Publish prompt beside it (MouthKitActions). A
 * compare switch plays the standard shapes in the preview instead of the
 * person's own (`motion`), so the same sentence can be heard both ways; it
 * changes nothing saved or published.
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
  const { t } = useT();
  const panel = useMouthPanel(avatar, orgId, onPreview);
  const character = !panel.human && avatar.kind === "photo";

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

      {character && <CharacterMouthSection avatar={avatar} orgId={orgId} onPreview={onPreviewCharacter} />}

      <div
        className={cx("grid gap-2", panel.choices.length === 1 ? "grid-cols-1" : "grid-cols-2", character && "hidden")}
        role="radiogroup"
        aria-label={t("mouthTitle")}
      >
        {panel.choices.map((option) => (
          <ChoiceCard
            key={option}
            selected={panel.renderer === option}
            disabled={panel.busy}
            {...panel.rendererRadio(option)}
          >
            {t(option === "classic" ? "mouthClassic" : "mouthContinuous")}
            <span className="mt-0.5 block text-xs font-normal text-gray-500">
              {t(option === "classic" ? "mouthClassicHint" : "mouthContinuousHint")}
            </span>
          </ChoiceCard>
        ))}
      </div>

      {panel.choices.length === 1 && <p className="text-xs leading-relaxed text-gray-500">{t("mouthHumanOnly")}</p>}

      {panel.continuous && (
        <>
          <div
            className="divide-y divide-black/[0.06] rounded-xl bg-black/[0.03] dark:divide-white/[0.06] dark:bg-white/[0.04]"
            id="mouth-teeth"
          >
            {panel.shapes && <MouthShapes shapes={panel.shapes} motion={motion} onMotion={onMotion} />}
            <MouthTeeth teeth={panel.teeth} />
            <MouthKitActions panel={panel} />
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {panel.spoken}
          </p>
          <MouthSliders panel={panel} />
        </>
      )}
      {panel.saveError && <FieldError>{panel.saveError}</FieldError>}
      {panel.consentDialog}
    </section>
  );
}
