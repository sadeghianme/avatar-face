import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { iconButtonClass } from "@/components/ui/button-styles";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { Icon } from "@/components/ui/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { InlineName } from "@/features/avatars/components/InlineName";
import { aiEditedLabels, aiEditedModels } from "@/features/avatars/teeth";
import { cx } from "@/lib/cx";
import type { Avatar } from "@/lib/types";

/** On a wide screen the head stays under the shell's header, full-bleed
 *  across the main column's padding, like the wizard's progress bar. */
const HEAD = cx(
  "pb-4 lg:sticky lg:top-[calc(3.5rem+env(safe-area-inset-top))] lg:z-20 lg:-mx-4 lg:-mt-4 lg:px-4 lg:pt-4",
  "lg:bg-white/85 lg:backdrop-blur-xl dark:lg:bg-ink/85"
);

/** The head's actions: one row that scrolls sideways on a phone (full-bleed,
 *  no scrollbar), wrapped on a wide screen. */
const HEAD_ACTIONS = cx(
  "-mx-4 flex min-w-0 max-w-[100vw] items-center gap-2 overflow-x-auto px-4 py-1 [scrollbar-width:none] [&>*]:shrink-0",
  "lg:mx-0 lg:max-w-none lg:flex-wrap lg:overflow-visible lg:px-0 lg:py-0"
);

/**
 * The avatar page's head: back, the name (edited in place), the status,
 * what the AI did, and the actions on the picture. Both rows wrap: on a
 * phone the title's disclosure and the row of tools are each wider than
 * the screen. The page measures it (ref) so the stage sticks just under it.
 */
export const AvatarPageHead = forwardRef<
  HTMLDivElement,
  {
    avatar: Avatar;
    onRename: (name: string) => Promise<void>;
    /** A ready photo: marking, cropping, the background, the Simulator. */
    editable: boolean;
    adjusting: boolean;
    onToggleAdjusting: () => void;
    cropping: boolean;
    onToggleCropping: () => void;
    busyBackground: boolean;
    onToggleBackground: () => void;
    onUndo: () => void;
    deleting: boolean;
    onDelete: () => void;
  }
>(function AvatarPageHead(
  {
    avatar,
    onRename,
    editable,
    adjusting,
    onToggleAdjusting,
    cropping,
    onToggleCropping,
    busyBackground,
    onToggleBackground,
    onUndo,
    deleting,
    onDelete,
  },
  ref
) {
  const { t } = useTranslation();
  return (
    <div ref={ref} className={HEAD}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          {/* Back before the title, not buried in the sidebar: a detail page
              reached from a list needs a way out of it that is where the eye
              already is. */}
          <Link
            to="/app"
            aria-label={t("avatars")}
            title={t("avatars")}
            className={cx(iconButtonClass(), "-ms-2 h-11 w-11")}
          >
            <Icon name="back" className="h-5 w-5 rtl:-scale-x-100" />
          </Link>
          <InlineName name={avatar.name} onSave={onRename} />
          <StatusBadge status={avatar.status} />
          {/* The same disclosure visitors get with the published avatar:
              what the AI did to the picture, "AI teeth" when it made the
              teeth photo too, "AI mouth shapes" when it made some of them. */}
          {avatar.ai_edited && (
            <Badge
              tone="brand"
              icon="sparkles"
              className="min-w-0 max-w-full px-2.5"
              title={
                aiEditedModels(avatar.ai_edited).length > 0
                  ? t("aiEditedModel", { model: aiEditedModels(avatar.ai_edited).join(", ") })
                  : undefined
              }
            >
              <span className="truncate">
                {aiEditedLabels(avatar.ai_edited)
                  .map((key) => t(key))
                  .join(" · ")}
              </span>
            </Badge>
          )}
        </div>

        {/* The actions, ranked: the edits to the picture first, Test (the
            widget on a page), then Delete, quiet and last. Publishing is
            not here: it is the settings column's own state (PublishBar).
            One row that scrolls sideways on a phone (three rows of
            buttons used to sit between the title and the avatar); wrapped
            on a wide screen. */}
        <div className={HEAD_ACTIONS}>
          {editable && (
            <>
              <Button variant="secondary" size="lg" icon="target" aria-pressed={adjusting} onClick={onToggleAdjusting}>
                {t("markFace")}
              </Button>
              <Button variant="secondary" size="lg" icon="crop" aria-pressed={cropping} onClick={onToggleCropping}>
                {t("crop")}
              </Button>
              <Button
                variant="secondary"
                size="lg"
                icon="eraser"
                onClick={onToggleBackground}
                disabled={busyBackground}
                title={t("removeBgHint")}
              >
                {busyBackground ? t("loading") : avatar.original_image_key ? t("restoreBg") : t("removeBg")}
              </Button>
            </>
          )}
          {avatar.undo_label && (
            <Button
              variant="secondary"
              size="lg"
              icon="undo"
              onClick={onUndo}
              title={t("undoWhat", { what: avatar.undo_label })}
            >
              {t("undoWhat", { what: avatar.undo_label })}
            </Button>
          )}
          {editable && (
            <ButtonLink variant="secondary" size="lg" icon="play" to={`/simulator?avatar=${avatar.id}`}>
              {t("testInSimulator")}
            </ButtonLink>
          )}
          {/* Asks once, in place; another avatar on this page drops the question (key). */}
          <ConfirmButton
            key={avatar.id}
            icon="trash"
            label={t("delete")}
            question={t("deleteAsk")}
            confirmLabel={t("delete")}
            cancelLabel={t("cancel")}
            busy={deleting}
            onConfirm={onDelete}
          />
        </div>
      </div>
    </div>
  );
});
