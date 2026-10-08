import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";

import { messages as en } from "./locales/en";
import { messages as fr } from "./locales/fr";
import type { MessageKey, Translate } from "./types";

export type { Locale, MessageKey, MessageValues, Translate } from "./types";

const RTL_LANGS = new Set(["ar", "fa", "he", "ur"]);

const resources = {
  en: { translation: en },
  fr: { translation: fr },
};

export function applyDirection(lang: string): void {
  const dir = RTL_LANGS.has(lang.split("-")[0]) ? "rtl" : "ltr";
  document.documentElement.dir = dir;
  document.documentElement.lang = lang;
}

void i18n.use(initReactI18next).init({
  resources,
  lng: localStorage.getItem("liveface.lang") ?? "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

applyDirection(i18n.language);
i18n.on("languageChanged", (lang) => {
  localStorage.setItem("liveface.lang", lang);
  applyDirection(lang);
});

/**
 * The translation hook every component uses (lint keeps react-i18next's
 * own to this file): react-i18next's `useTranslation`, its `t` typed to
 * take only the keys en defines (types.ts).
 */
export function useT(): { t: Translate; i18n: typeof i18n } {
  const { t, i18n: instance } = useTranslation();
  return { t: t as Translate, i18n: instance };
}

/** `t` outside a component (the current language, no re-render on change). */
export const translate: Translate = (key, values) => i18n.t(key, values);

/** Whether en defines `key`: for a key made from a server's code, which a
 *  type cannot know; true narrows it to a MessageKey. */
export function isMessageKey(key: string): key is MessageKey {
  return i18n.exists(key);
}

export default i18n;
