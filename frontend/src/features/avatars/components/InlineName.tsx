import { useTranslation } from "react-i18next";

import { InlineEdit } from "@/components/ui/InlineEdit";

/**
 * The avatar's name as its page's title, edited where it stands (the kit's
 * InlineEdit): Enter or leaving the field saves, Escape puts it back.
 */
export function InlineName({ name, onSave }: { name: string; onSave: (next: string) => Promise<void> }) {
  const { t } = useTranslation();
  return (
    <InlineEdit
      value={name}
      onSave={onSave}
      labels={{
        field: t("wzRenameLabel"),
        edit: t("wzRename"),
        hint: t("wzRenameHint"),
        failed: t("wzRenameFailed"),
        saved: t("wzRenameSaved"),
      }}
    />
  );
}
