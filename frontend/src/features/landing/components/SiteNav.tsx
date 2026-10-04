import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { LanguageMenu } from "@/components/layout/LanguageMenu";
import { Icon } from "@/components/ui/Icon";
import { useAuth } from "@/providers/auth";
import { useTheme } from "@/providers/theme";

const LINKS = [
  { href: "#features", key: "navProduct" },
  { href: "#how", key: "navHow" },
  { href: "#platform", key: "navPlatform" },
  { href: "#developers", key: "navDevelopers" },
  { href: "#faq", key: "navFaq" },
] as const;

/** Sticky, transparent over the hero, solid once the page scrolls. */
export function SiteNav() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { theme, toggle } = useTheme();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const solid = scrolled || open;

  return (
    <header
      className={`sticky top-0 z-50 pt-[env(safe-area-inset-top)] transition-[background-color,border-color,backdrop-filter] duration-300 ${
        solid
          ? "border-b border-black/[0.06] bg-white/80 backdrop-blur-xl dark:border-white/[0.07] dark:bg-ink/80"
          : "border-b border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-5 sm:px-6" aria-label={t("navMain")}>
        <Link to="/" className="flex shrink-0 items-center gap-2.5 text-[17px] font-semibold tracking-[-0.02em]">
          <img src="/brand/liveface-mark-512.png" alt="" width={32} height={32} className="h-8 w-8 rounded-[10px]" />
          {t("appName")}
        </Link>

        <ul className="ms-6 hidden items-center gap-1 lg:flex">
          {LINKS.map((link) => (
            <li key={link.key}>
              <a
                href={link.href}
                className="rounded-lg px-3 py-2 text-[14px] text-gray-600 transition-colors hover:text-gray-950 dark:text-gray-400 dark:hover:text-white"
              >
                {t(link.key)}
              </a>
            </li>
          ))}
        </ul>

        <div className="ms-auto flex items-center gap-1.5">
          <LanguageMenu />
          <button
            type="button"
            onClick={toggle}
            aria-label={t("theme")}
            title={t("theme")}
            className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-black/5 hover:text-gray-900 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} className="h-[18px] w-[18px]" />
          </button>
          {user ? (
            <Link to="/app" className="btn-primary ms-1 hidden rounded-full px-4 sm:inline-flex">
              {t("openDashboard")}
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                className="hidden rounded-full px-3.5 py-2 text-[14px] font-medium text-gray-700 transition-colors hover:text-gray-950 sm:inline-flex dark:text-gray-300 dark:hover:text-white"
              >
                {t("login")}
              </Link>
              <Link to="/register" className="btn-primary ms-1 hidden rounded-full px-4 sm:inline-flex">
                {t("getStarted")}
              </Link>
            </>
          )}
          <button
            type="button"
            className="rounded-lg p-2 text-gray-700 hover:bg-black/5 lg:hidden dark:text-gray-200 dark:hover:bg-white/10"
            aria-label={t("navMenu")}
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name={open ? "close" : "menu"} className="h-5 w-5" />
          </button>
        </div>
      </nav>

      {open && (
        <div id="mobile-nav" className="border-t border-black/[0.06] px-5 pb-6 pt-2 lg:hidden dark:border-white/[0.07]">
          <ul className="flex flex-col">
            {LINKS.map((link) => (
              <li key={link.key}>
                <a
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-2 py-3 text-[15px] font-medium text-gray-800 hover:bg-black/[0.03] dark:text-gray-100 dark:hover:bg-white/[0.04]"
                >
                  {t(link.key)}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {user ? (
              <Link to="/app" className="btn-primary col-span-2 py-3">
                {t("openDashboard")}
              </Link>
            ) : (
              <>
                <Link to="/login" className="btn-secondary py-3">
                  {t("login")}
                </Link>
                <Link to="/register" className="btn-primary py-3">
                  {t("getStarted")}
                </Link>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
