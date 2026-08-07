import { ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { useTheme } from "../lib/theme";

/**
 * The speaking waveform from the landing page, at a calmer amplitude.
 *
 * The auth screen is the one place every user passes through, so it may as
 * well show what the product does instead of being a form on a grey field.
 */
function Waveform() {
  const [bars, setBars] = useState<number[]>(() => Array(34).fill(0.12));

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let t = 0;
    const id = window.setInterval(() => {
      t += 1;
      setBars((prev) => {
        const next = prev.slice(1);
        // Peaks at syllable rate, quiet between phrases — speech, not a
        // level meter.
        const speaking = Math.sin(t / 38) > -0.3;
        const syllable = Math.abs(Math.sin(t / 2.3)) ** 1.7;
        next.push(speaking ? 0.1 + syllable * 0.75 : 0.05);
        return next;
      });
    }, 62);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex h-16 items-end gap-1" aria-hidden="true">
      {bars.map((v, i) => (
        <span
          key={i}
          className="flex-1 rounded-full bg-brand-500"
          style={{ height: `${Math.max(6, v * 100)}%`, transition: "height 80ms linear" }}
        />
      ))}
    </div>
  );
}

/**
 * Split auth layout: the product on one side, the form on the other.
 *
 * The panel is hidden below `lg` rather than stacked — on a phone the form is
 * the only thing anyone came for, and pushing it under a marketing panel just
 * makes people scroll past it.
 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { theme, toggle } = useTheme();

  const points = ["authPoint1", "authPoint2", "authPoint3"];

  return (
    <div className="grid min-h-screen bg-white text-gray-900 antialiased lg:grid-cols-[1.05fr_1fr] dark:bg-ink dark:text-gray-100">
      {/* ---- brand panel ---- */}
      <aside className="relative hidden overflow-hidden border-e border-black/[0.07] bg-[#fafaf9] p-12 lg:flex lg:flex-col lg:justify-between dark:border-white/[0.07] dark:bg-panel">
        <Link to="/" className="relative flex items-center gap-2.5 text-[15px] font-semibold tracking-[-0.01em]">
          <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-brand-500 text-[13px] text-white">
            ◕
          </span>
          {t("appName")}
        </Link>

        <div className="relative max-w-md">
          <h2 className="text-[34px] font-semibold leading-[1.1] tracking-[-0.03em]">{t("authPanelTitle")}</h2>
          <p className="mt-4 text-[15px] leading-relaxed text-gray-500 dark:text-gray-400">{t("authPanelBody")}</p>

          <div className="mt-9 rounded-2xl bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] dark:bg-raised dark:shadow-none">
            <Waveform />
            <p className="mt-3 truncate font-mono text-[11.5px] text-gray-400">
              Liveface.speak(&quot;{t("heroDemoLine1")}&quot;)
            </p>
          </div>

          <ul className="mt-8 space-y-3">
            {points.map((k) => (
              <li key={k} className="flex items-start gap-2.5 text-[13.5px] text-gray-600 dark:text-gray-300">
                <span className="mt-[3px] text-brand-500">✓</span>
                {t(k)}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-[11.5px] text-gray-400">
          © {new Date().getFullYear()} {t("appName")}
        </p>
      </aside>

      {/* ---- form side ---- */}
      <main className="relative flex flex-col bg-white dark:bg-ink">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_40%_at_80%_0%,rgba(249,115,22,0.10),transparent)] lg:hidden"
        />
        <header className="relative flex items-center justify-between px-6 py-5">
          <Link
            to="/"
            className="flex items-center gap-2 text-lg font-bold tracking-tight text-gray-900 lg:invisible dark:text-white"
          >
            <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-brand-500 text-[13px] text-white">
              ◕
            </span>
            {t("appName")}
          </Link>
          <div className="flex items-center gap-2">
            <select
              aria-label={t("language")}
              className="input w-auto py-1.5 text-sm"
              value={i18n.language}
              onChange={(e) => void i18n.changeLanguage(e.target.value)}
            >
              <option value="en">English</option>
              <option value="fr">Français</option>
            </select>
            <button className="btn-secondary px-3 py-1.5" onClick={toggle} aria-label={t("theme")}>
              {theme === "dark" ? "☀️" : "🌙"}
            </button>
          </div>
        </header>

        <div className="relative flex flex-1 items-center justify-center px-6 pb-16">
          <div className="w-full max-w-sm">
            <h1 className="text-[30px] font-semibold tracking-[-0.03em] text-gray-900 dark:text-white">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>
            )}
            <div className="mt-8">{children}</div>
          </div>
        </div>

        <Link
          to="/"
          className="relative px-6 pb-6 text-center text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        >
          ← {t("backToSite")}
        </Link>
      </main>
    </div>
  );
}
