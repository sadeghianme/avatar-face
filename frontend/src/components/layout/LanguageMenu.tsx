import { MenuButton } from "@/components/ui/MenuButton";
import { useT } from "@/i18n";

/**
 * Language, in the header beside the theme toggle.
 *
 * A menu rather than a button that cycles: cycling is fine for two languages
 * and becomes guesswork at three, and the list is meant to grow. The native
 * name is shown rather than a flag — languages are not countries, and French
 * is not a French flag to most of the people who read it.
 */
const LANGUAGES: { code: string; name: string }[] = [
  { code: "en", name: "English" },
  { code: "fr", name: "Français" },
];

export function LanguageMenu() {
  const { t, i18n } = useT();
  const active = i18n.language.split("-")[0];
  return (
    <MenuButton
      label={t("language")}
      icon="globe"
      choices={LANGUAGES.map((lang) => ({
        key: lang.code,
        label: lang.name,
        checked: active === lang.code,
        onSelect: () => void i18n.changeLanguage(lang.code),
      }))}
    />
  );
}
