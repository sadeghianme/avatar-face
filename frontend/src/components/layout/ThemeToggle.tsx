import { IconButton } from "@/components/ui/IconButton";
import { useT } from "@/i18n";
import { useTheme } from "@/providers/theme";

/** Light or dark, in the header of every page: the sun shows in the dark. */
export function ThemeToggle({ tooltip = false }: { tooltip?: boolean }) {
  const { t } = useT();
  const { theme, toggle } = useTheme();
  return <IconButton label={t("theme")} tooltip={tooltip} icon={theme === "dark" ? "sun" : "moon"} onClick={toggle} />;
}
