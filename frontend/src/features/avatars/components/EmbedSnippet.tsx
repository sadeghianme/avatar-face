import { useTranslation } from "react-i18next";

import { CodeBlock } from "@/components/ui/CodeBlock";
import { buildSnippet, type SnippetVoice } from "@/features/avatars/snippet";

/** The snippet to paste, with Copy: the avatar page's Embed section. */
export function EmbedSnippet({ avatarId, apiKey, voice }: { avatarId: string; apiKey?: string; voice?: SnippetVoice }) {
  const { t } = useTranslation();
  return (
    <CodeBlock
      code={buildSnippet(avatarId, apiKey, voice)}
      header={<p className="text-[13px] text-gray-500 max-lg:text-sm dark:text-gray-400">{t("embedSnippetHint")}</p>}
      copy={{ label: t("copy"), copiedLabel: t("copied") }}
    />
  );
}
