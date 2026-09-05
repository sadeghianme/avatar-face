import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { messages as en } from "./locales/en";
import { messages as fr } from "./locales/fr";

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

export default i18n;
