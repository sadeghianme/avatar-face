import { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useTheme } from "../lib/theme";

/** Themed + translated landing/login shell. */
export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { theme, toggle } = useTheme();

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 dark:bg-gray-900">
      <header className="flex items-center justify-between px-6 py-4">
        <span className="text-xl font-bold text-brand-600">{t("appName")}</span>
        <div className="flex items-center gap-3">
          <select
            aria-label={t("language")}
            className="input w-auto py-1"
            value={i18n.language}
            onChange={(e) => void i18n.changeLanguage(e.target.value)}
          >
            <option value="en">English</option>
            <option value="fr">Français</option>
          </select>
          <button className="btn-secondary px-3 py-1" onClick={toggle}>
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-md">
          <p className="mb-6 text-center text-gray-500 dark:text-gray-400">{t("tagline")}</p>
          <div className="card">
            <h1 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
              {title}
            </h1>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
