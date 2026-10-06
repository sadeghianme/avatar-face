import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/IconButton";
import { useTheme } from "@/providers/theme";

/** Light or dark, in the header of every page: the sun shows in the dark. */
export function ThemeToggle({ tooltip = false }: { tooltip?: boolean }) {
  const { t } = useTranslation();
  const { theme, toggle } = useTheme();
  return <IconButton label={t("theme")} tooltip={tooltip} icon={theme === "dark" ? "sun" : "moon"} onClick={toggle} />;
}
