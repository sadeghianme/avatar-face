import type { CharacterSettings } from "@liveface/embed/mouth";
import { useEffect, useRef, useState } from "react";

import { Checkbox } from "@/components/ui/Checkbox";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { FieldError } from "@/components/ui/FieldError";
import { Slider } from "@/components/ui/Slider";
import { useRadioGroup } from "@/components/ui/useRadioGroup";
import { useUpdateAvatar } from "@/features/avatars/api";
import {
  characterSettings,
  characterUpdate,
  JAW_LIMITS,
  mouthLook,
  styleChange,
} from "@/features/avatars/character-mouth";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";
import type { Avatar } from "@/lib/types";

type Style = "character" | "classic";

/**
 * How an animation or an animal talks: with the character mouth (a drawn or
 * rendered opening, a tongue, a toon's teeth, a jaw that opens the muzzle) or
 * with the original one. Part of the Mouth panel, and a draft edit like the
 * rest: the preview moves at once, and visitors see it after Publish.
 *
 * An avatar made before the character mouth keeps its original mouth, and says
 * so, until its owner chooses the new one here (or marks its face again).
 * Choosing moves the draft rig's look, so the avatar is fetched again; the
 * teeth, tongue and jaw are plain settings, previewed live and saved on
 * release.
 */
export function CharacterMouthSection({
  avatar,
  orgId,
  onPreview,
}: {
  avatar: Avatar;
  orgId: string;
  /** The settings being edited, for the preview; null when saved. */
  onPreview: (settings: CharacterSettings | null) => void;
}) {
  const { t } = useT();
  const update = useUpdateAvatar(orgId, avatar.id);
  const look = mouthLook(avatar);
  const savedKey = JSON.stringify(avatar.mouth?.character ?? null);
  const [settings, setSettings] = useState(() => characterSettings(avatar.mouth?.character));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed when the server's copy changes under us (publish, discard):
  // keyed by its content, not by the object a refetch replaces.
  const savedCharacter = useRef(avatar.mouth?.character);
  savedCharacter.current = avatar.mouth?.character;
  useEffect(() => {
    setSettings(characterSettings(savedCharacter.current));
  }, [savedKey]);

  const styles: readonly Style[] = ["character", "classic"];
  const selectedStyle: Style = look === "character" ? "character" : "classic";
  const styleRadio = useRadioGroup(
    styles,
    selectedStyle,
    (style) => choose(style),
    () => busy
  );

  if (look === null) return null;

  const save = async (next: Required<CharacterSettings>, style: Style) => {
    setBusy(true);
    setError(null);
    try {
      await update.mutateAsync({
        body: { character: characterUpdate(next, style) },
        // A new look is on the rig, rewritten under an unchanged key: the
        // avatar fetched again, which also rebuilds the preview on it.
        refetch: styleChange(look, style) ? "all" : undefined,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(false);
    }
  };

  function choose(style: Style) {
    if (look === null || !styleChange(look, style) || busy) return;
    void save(settings, style);
  }

  const change = (patch: Partial<Required<CharacterSettings>>, saveNow: boolean) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    onPreview(characterUpdate(next, "character"));
    if (saveNow) void save(next, "character");
  };

  const options: { style: Style; label: string; hint: string }[] = [
    { style: "character", label: t("mouthCharacter"), hint: t("mouthCharacterHint") },
    { style: "classic", label: t("mouthOriginal"), hint: t("mouthOriginalHint") },
  ];

  return (
    <div className="space-y-3" id="mouth-character">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("mouthCharacterTitle")}>
        {options.map((option) => (
          <ChoiceCard
            key={option.style}
            selected={option.style === selectedStyle}
            disabled={busy}
            {...styleRadio(option.style)}
          >
            {option.label}
            <span className="mt-0.5 block text-xs font-normal text-gray-500">{option.hint}</span>
          </ChoiceCard>
        ))}
      </div>

      {look === "original" && <p className="text-xs leading-relaxed text-gray-500">{t("mouthCharacterLegacy")}</p>}

      {look === "character" && (
        <div className="space-y-3 rounded-xl bg-black/[0.03] p-3 dark:bg-white/[0.04]">
          <Checkbox
            label={t("mouthCharacterTeeth")}
            checked={settings.teeth === "upper"}
            disabled={busy}
            onChange={(event) => change({ teeth: event.target.checked ? "upper" : "none" }, true)}
          />
          <Checkbox
            label={t("mouthCharacterTongue")}
            checked={settings.tongue}
            disabled={busy}
            onChange={(event) => change({ tongue: event.target.checked }, true)}
          />
          <Slider
            id="mouth-character-jaw"
            label={t("mouthJaw")}
            min={JAW_LIMITS.min}
            max={JAW_LIMITS.max}
            step={JAW_LIMITS.step}
            value={settings.jaw}
            onChange={(jaw) => change({ jaw }, false)}
            // Saved on release, not per tick: each save is a draft edit.
            onPointerUp={() => void save(settings, "character")}
            onKeyUp={() => void save(settings, "character")}
          />
        </div>
      )}
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}
