import type { CharacterSettings } from "@liveface/embed/mouth";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  JAW_LIMITS,
  characterSettings,
  characterUpdate,
  mouthLook,
  styleChange,
} from "@/features/avatars/character-mouth";
import { api, ApiError } from "@/lib/api";
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
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const look = mouthLook(avatar);
  const savedKey = JSON.stringify(avatar.mouth?.character ?? null);
  const [settings, setSettings] = useState(() => characterSettings(avatar.mouth?.character));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/orgs/${orgId}/avatars/${avatar.id}`;

  // Re-seed when the server's copy changes under us (publish, discard).
  useEffect(() => {
    setSettings(characterSettings(avatar.mouth?.character));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  if (look === null) return null;

  const save = async (next: Required<CharacterSettings>, style: Style) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.patch<Avatar>(base, { character: characterUpdate(next, style) });
      if (styleChange(look, style)) {
        // The look is on the rig, rewritten under an unchanged key: fetched
        // again, which also rebuilds the preview on the new rig.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["avatar", orgId, avatar.id] }),
          queryClient.invalidateQueries({ queryKey: ["avatars", orgId] }),
        ]);
      } else {
        queryClient.setQueryData<Avatar>(["avatar", orgId, avatar.id], (old) =>
          old ? { ...old, ...updated } : old
        );
        void queryClient.invalidateQueries({ queryKey: ["avatars", orgId] });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(false);
    }
  };

  const choose = (style: Style) => {
    if (!styleChange(look, style) || busy) return;
    void save(settings, style);
  };

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
        {options.map((option) => {
          const selected = (look === "character") === (option.style === "character");
          return (
            <button
              key={option.style}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy}
              onClick={() => choose(option.style)}
              className={`rounded-xl border px-3 py-2.5 text-start text-sm transition-colors ${
                selected
                  ? "border-brand-500 bg-brand-500/10 font-medium"
                  : "border-black/10 hover:border-black/25 dark:border-white/10 dark:hover:border-white/25"
              }`}
            >
              {option.label}
              <span className="mt-0.5 block text-xs font-normal text-gray-500">{option.hint}</span>
            </button>
          );
        })}
      </div>

      {look === "original" && (
        <p className="text-xs leading-relaxed text-gray-500">{t("mouthCharacterLegacy")}</p>
      )}

      {look === "character" && (
        <div className="space-y-3 rounded-xl bg-black/[0.03] p-3 dark:bg-white/[0.04]">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-orange-500"
              checked={settings.teeth === "upper"}
              disabled={busy}
              onChange={(event) => change({ teeth: event.target.checked ? "upper" : "none" }, true)}
            />
            {t("mouthCharacterTeeth")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-orange-500"
              checked={settings.tongue}
              disabled={busy}
              onChange={(event) => change({ tongue: event.target.checked }, true)}
            />
            {t("mouthCharacterTongue")}
          </label>
          <div>
            <label className="label flex justify-between gap-2" htmlFor="mouth-character-jaw">
              <span>{t("mouthJaw")}</span>
              <span className="font-mono tabular-nums">{settings.jaw.toFixed(2)}</span>
            </label>
            <input
              id="mouth-character-jaw"
              type="range"
              className="w-full accent-orange-500"
              min={JAW_LIMITS.min}
              max={JAW_LIMITS.max}
              step={JAW_LIMITS.step}
              value={settings.jaw}
              onChange={(event) => change({ jaw: Number(event.target.value) }, false)}
              // Saved on release, not per tick: each save is a draft edit.
              onPointerUp={() => void save(settings, "character")}
              onKeyUp={() => void save(settings, "character")}
            />
          </div>
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}
