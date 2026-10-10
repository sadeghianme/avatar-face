import type { RefObject } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Disclosure, DisclosureGroup } from "@/components/ui/Disclosure";
import { useExpressions } from "@/features/avatars/api";
import { EmbedSnippet } from "@/features/avatars/components/EmbedSnippet";
import { ExpressionsPanel } from "@/features/avatars/components/ExpressionsPanel";
import { FinishNotice } from "@/features/avatars/components/FinishNotice";
import { FramingScenePanel } from "@/features/avatars/components/FramingScenePanel";
import { MouthPanel } from "@/features/avatars/components/MouthPanel";
import { PublishBar } from "@/features/avatars/components/PublishBar";
import { SharePanel } from "@/features/avatars/components/SharePanel";
import { TuningPanel } from "@/features/avatars/components/TuningPanel";
import { summaryKey } from "@/features/avatars/expressions";
import type { AvatarDetailState } from "@/features/avatars/hooks/useAvatarDetail";
import type { useOpenSections } from "@/features/avatars/hooks/useOpenSections";
import { draftMouthConfig } from "@/features/avatars/mouth-config";
import { SpeakPanel } from "@/features/voices";
import { useT } from "@/i18n";
import type { Avatar, Org } from "@/lib/types";

/**
 * The settings column: the quality note when there is one, the publish
 * state, the finish notice, Speak, then the settings in named groups
 * (Disclosure): Look (Framing & scene, Mouth, Expressions for a person's
 * photo), Publish & share (the public
 * link, the embed snippet), Advanced (animation tuning, the mesh).
 */
export function SettingsColumn({
  avatar,
  org,
  page,
  sections,
  stageRef,
}: {
  avatar: Avatar;
  org: Org;
  page: AvatarDetailState;
  sections: ReturnType<typeof useOpenSections>;
  stageRef: RefObject<HTMLDivElement>;
}) {
  const { t } = useT();
  const photo = avatar.kind === "photo";
  const is3d = avatar.kind === "model3d";
  const human = (avatar.face_type ?? "human") === "human";
  // The section's summary; the panel inside asks the same query.
  const expressions = useExpressions(org.id, avatar.id, photo && human);
  const mouthSummary = human
    ? t(avatar.mouth?.renderer === "continuous" ? "mouthContinuous" : "mouthClassic")
    : t("mouthSummary");

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {avatar.quality_note && (
        <Card tone="warning" padding="sm">
          <p className="text-[13.5px] text-amber-700 dark:text-amber-400">
            <span className="font-medium">{avatar.published ? t("qualityNoteTitle") : t("qualityNoteFirstTitle")}</span>{" "}
            {avatar.quality_note}
          </p>
          {/* "It still works" is about a live avatar; before the first
              publish the note itself says what to do. */}
          {avatar.published && (
            <p className="mt-1 text-[13px] text-gray-500 dark:text-gray-400">{t("qualityNoteHint")}</p>
          )}
          {photo && !page.adjusting && (
            <Button
              variant="secondary"
              size="sm"
              icon="target"
              className="mt-3"
              onClick={() => page.openTool("adjusting")}
            >
              {t("markFace")}
            </Button>
          )}
        </Card>
      )}

      <PublishBar avatar={avatar} orgId={org.id} />

      {/* Keyed by avatar: a notice read for one avatar is not shown on the
          next one this page opens. */}
      <FinishNotice
        key={avatar.id}
        avatar={avatar}
        aiEnabled={org.third_party_ai_enabled ?? true}
        onToMouth={() => sections.reveal("mouth")}
      />

      <SpeakPanel
        engine={page.engine}
        orgId={org.id}
        selection={page.voice}
        onSelectionChange={page.saveVoice}
        title={t("speakPanelTitle")}
        hint={t("speakPanelHint")}
      />

      {!is3d && (
        <DisclosureGroup label={t("sectionLook")}>
          {photo && (
            <Disclosure
              id="scene"
              icon="image"
              title={t("sceneTitle")}
              summary={t("sceneSummary")}
              open={sections.open.scene}
              onToggle={() => sections.toggle("scene")}
            >
              <FramingScenePanel
                avatar={avatar}
                orgId={org.id}
                surfaceRef={stageRef}
                active={!page.cropping && !page.adjusting}
                onPreview={page.previewScene}
                onRemoveBackground={page.toggleBackground}
                busyBackground={page.busyBackground}
              />
            </Disclosure>
          )}
          <Disclosure
            id="mouth"
            icon="faces"
            title={t("mouthTitle")}
            summary={mouthSummary}
            open={sections.open.mouth}
            onToggle={() => sections.toggle("mouth")}
          >
            <MouthPanel
              avatar={avatar}
              orgId={org.id}
              onPreview={(renderer, profile) => page.previewMouth(draftMouthConfig(avatar, renderer, profile))}
              onPreviewCharacter={(settings) =>
                page.previewMouth(settings ? draftMouthConfig(avatar, undefined, undefined, settings) : undefined)
              }
              motion={page.preview.motion}
              onMotion={page.setMotion}
            />
          </Disclosure>
          {photo && human && (
            <Disclosure
              id="expressions"
              icon="sparkles"
              title={t("exprTitle")}
              summary={t(summaryKey(expressions.data))}
              open={sections.open.expressions}
              onToggle={() => sections.toggle("expressions")}
            >
              <ExpressionsPanel avatar={avatar} orgId={org.id} />
            </Disclosure>
          )}
        </DisclosureGroup>
      )}

      <DisclosureGroup label={t("sectionPublish")}>
        <Disclosure
          id="share"
          icon="link"
          title={t("shareTitle")}
          summary={avatar.share_token ? t("shareSummaryOn") : t("shareSummaryOff")}
          open={sections.open.share}
          onToggle={() => sections.toggle("share")}
        >
          <SharePanel avatar={avatar} orgId={org.id} />
        </Disclosure>
        <Disclosure
          id="embed"
          icon="code"
          title={t("embedSnippet")}
          summary={t("embedSummary")}
          open={sections.open.embed}
          onToggle={() => sections.toggle("embed")}
        >
          <EmbedSnippet avatarId={avatar.id} voice={page.voice} />
        </Disclosure>
      </DisclosureGroup>

      <DisclosureGroup label={t("sectionAdvanced")}>
        <Disclosure
          id="tuning"
          icon="sliders"
          title={t("tuning")}
          summary={t("tuningSummary")}
          open={sections.open.tuning}
          onToggle={() => sections.toggle("tuning")}
        >
          <TuningPanel engine={page.engine} avatarId={avatar.id} is3d={is3d} />
          {photo && (
            <Checkbox
              className="mt-4 min-h-11 border-t border-gray-100 pt-4 dark:border-white/[0.07]"
              label={t("debugMesh")}
              description={t("debugMeshHint")}
              checked={page.preview.debugMesh}
              onChange={(e) => page.setDebugMesh(e.target.checked)}
            />
          )}
        </Disclosure>
      </DisclosureGroup>
    </div>
  );
}
