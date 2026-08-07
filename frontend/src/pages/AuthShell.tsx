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
          className="flex-1 rounded-full bg-white/70"
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
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* ---- brand panel ---- */}
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-brand-500 to-brand-600 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_40%_at_20%_15%,rgba(255,255,255,0.22),transparent),radial-gradient(45%_35%_at_85%_80%,rgba(255,255,255,0.14),transparent)]"
        />
        <Link to="/" className="relative flex items-center gap-2.5 text-xl font-bold tracking-tight">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/20 backdrop-blur">
            ◕
          </span>
          {t("appName")}
        </Link>

        <div className="relative max-w-md">
          <h2 className="text-3xl font-bold leading-tight">{t("authPanelTitle")}</h2>
          <p className="mt-4 leading-relaxed text-white/80">{t("authPanelBody")}</p>

          <div className="mt-8 rounded-2xl border border-white/20 bg-white/10 p-5 backdrop-blur-sm">
            <Waveform />
            <p className="mt-3 truncate font-mono text-xs text-white/80">
              Liveface.speak(&quot;{t("heroDemoLine1")}&quot;)
            </p>
          </div>

          <ul className="mt-8 space-y-3">
            {points.map((k) => (
              <li key={k} className="flex items-start gap-3 text-sm text-white/85">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/20 text-[11px]">
                  ✓
                </span>
                {t(k)}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-white/50">
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
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 text-white">
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
            <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
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
