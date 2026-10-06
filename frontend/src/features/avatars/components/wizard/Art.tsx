import portrait from "@/assets/demo/portrait.webp";
import animalAnimation from "@/assets/wizard/animal-animation.webp";
import animalCartoon from "@/assets/wizard/animal-cartoon.webp";
import animalRealistic from "@/assets/wizard/animal-realistic.webp";
import humanAnimation from "@/assets/wizard/human-animation.webp";
import humanCartoon from "@/assets/wizard/human-cartoon.webp";
import type { AvatarModel, Look } from "@/features/avatars/wizard";

/**
 * The wizard's pictures: one character per model in each look, so the
 * choice of style is shown rather than described. They are real outputs of
 * the wizard's own prompts (fictional characters), cut out and cropped to
 * head and shoulders, 360 px WebPs with transparency
 * (backend/scripts/build_style_thumbs.py); a person's Realistic is the
 * Reference avatar's portrait. The card's own backdrop shows through, in
 * light and dark.
 *
 * Decorative: every picture is aria-hidden, the card it sits in carries
 * the words.
 */
const PICTURES: Record<AvatarModel, Record<Look, string>> = {
  human: { realistic: portrait, animation: humanAnimation, cartoon: humanCartoon },
  animal: { realistic: animalRealistic, animation: animalAnimation, cartoon: animalCartoon },
};

/** A model in a look, filling its box from the top (a face, not a body). */
export function LookPicture({ model, look, className }: { model: AvatarModel; look: Look; className?: string }) {
  return (
    <img
      src={PICTURES[model][look]}
      alt=""
      aria-hidden="true"
      draggable={false}
      loading="lazy"
      width={360}
      height={360}
      className={`${className ?? ""} object-cover ${model === "human" && look === "realistic" ? "object-[50%_30%]" : "object-top"}`}
    />
  );
}

/** The backdrop every look sits on in the wizard: warm in light, deep in
 * dark, and the same under a photo and a drawing so they compare. */
export const PICTURE_BACKDROP = "bg-gradient-to-b from-brand-50 to-orange-100/70 dark:from-ember-850 dark:to-ember-950";

/** A checkerboard, for pictures whose background was taken off. */
export const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, rgba(127,127,127,.13) 25%, transparent 25%), linear-gradient(-45deg, rgba(127,127,127,.13) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(127,127,127,.13) 75%), linear-gradient(-45deg, transparent 75%, rgba(127,127,127,.13) 75%)",
  backgroundSize: "20px 20px",
  backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0",
};
