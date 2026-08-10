import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "./Icon";

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
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onAway = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onAway);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const active = i18n.language.split("-")[0];

  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={t("language")}
        title={t("language")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-black/5 hover:text-gray-900 dark:hover:bg-white/10 dark:hover:text-white"
      >
        <Icon name="globe" className="h-[18px] w-[18px]" />
      </button>

      {open && (
        <div
          role="menu"
          // `end-0` not `right-0`: the header flips in RTL, and a menu pinned
          // to the right would hang off the screen in Arabic or Hebrew.
          className="absolute end-0 z-50 mt-1 min-w-[9rem] overflow-hidden rounded-xl border border-black/[0.08] bg-white py-1 shadow-lg dark:border-white/[0.1] dark:bg-panel"
        >
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              role="menuitemradio"
              aria-checked={active === lang.code}
              onClick={() => {
                void i18n.changeLanguage(lang.code);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-start text-[13.5px] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${
                active === lang.code ? "font-medium" : "text-gray-600 dark:text-gray-300"
              }`}
            >
              <Icon
                name="check"
                className={`h-3.5 w-3.5 ${active === lang.code ? "" : "opacity-0"}`}
                strokeWidth={2.4}
              />
              {lang.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
