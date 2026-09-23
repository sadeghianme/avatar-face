import { ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { DEMO_PORTRAIT, DemoAvatar } from "@/components/brand/DemoAvatar";
import { LanguageMenu } from "@/components/layout/LanguageMenu";
import { Icon } from "@/components/ui/Icon";
import { useTheme } from "@/providers/theme";

/**
 * Split auth layout: the product on one side, the form on the other.
 *
 * The brand panel is the same avatar as the landing page, running its idle
 * loop — breathing, blinking, glancing — so the one screen every user passes
 * through shows what the product does. It is hidden below `lg` rather than
 * stacked: on a phone the form is the only thing anyone came for.
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
  const { t } = useTranslation();
  const { theme, toggle } = useTheme();

  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · ${t("appName")}`;
    return () => {
      document.title = previous;
    };
  }, [title, t]);

  return (
    <div className="grid min-h-screen bg-white text-gray-900 antialiased lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] dark:bg-ink dark:text-gray-100">
      {/* ---- brand panel ---- */}
      <aside className="relative isolate hidden overflow-hidden border-e border-white/[0.06] bg-[#0c0a09] p-10 text-white lg:flex lg:flex-col xl:p-12">
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-[linear-gradient(to_right,rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.045)_1px,transparent_1px)] bg-[size:44px_44px] [mask-image:radial-gradient(ellipse_75%_60%_at_50%_42%,black,transparent)]"
        />
        <div
          aria-hidden="true"
          className="absolute left-1/2 top-[40%] -z-10 h-[460px] w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-500/25 blur-[110px] motion-safe:animate-glow"
        />

        <Link to="/" className="flex w-fit items-center gap-2.5 text-[16px] font-semibold tracking-[-0.02em]">
          <img src="/brand/liveface-mark-512.png" alt="" width={32} height={32} className="h-8 w-8 rounded-[10px]" />
          {t("appName")}
        </Link>

        <div className="flex flex-1 flex-col items-center justify-center py-10">
          <div className="relative w-full max-w-[320px] xl:max-w-[350px]">
            <div aria-hidden="true" className="absolute -inset-5 rounded-[36px] border border-white/10" />
            <div aria-hidden="true" className="absolute -inset-10 rounded-[44px] border border-white/[0.05]" />
            <DemoAvatar
              mode="idle"
              label={t("authAvatarLabel")}
              className="rounded-[28px] bg-gray-900 shadow-[0_40px_120px_-30px_rgba(249,115,22,0.55)] ring-1 ring-white/15"
            />
            <p
              dir="ltr"
              className="absolute -bottom-6 left-1/2 w-[calc(100%+2.5rem)] -translate-x-1/2 rounded-2xl bg-[#171412]/85 px-4 py-3 font-mono text-[11.5px] leading-relaxed text-gray-300 shadow-xl ring-1 ring-white/10 backdrop-blur-md"
            >
              <span className="text-sky-300">Liveface</span>.speak(
              <span className="text-emerald-300">&quot;{t("authSpeakLine")}&quot;</span>)
              <span aria-hidden="true" className="ms-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] bg-brand-400 motion-safe:animate-caret" />
            </p>
          </div>

          <div className="mt-16 max-w-md text-center">
            <h2 className="text-balance text-[28px] font-semibold leading-[1.12] tracking-[-0.03em] xl:text-[32px]">
              {t("authPanelTitle")}
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-gray-400">{t("authPanelBody")}</p>
          </div>

          <ul className="mt-7 flex flex-wrap justify-center gap-2">
            {["authPoint1", "authPoint2", "authPoint3"].map((key) => (
              <li
                key={key}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3.5 py-1.5 text-[13px] text-gray-300 ring-1 ring-white/10"
              >
                <Icon name="check" className="h-3.5 w-3.5 text-brand-400" strokeWidth={2.4} />
                {t(key)}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-[12px] text-gray-500">
          © {new Date().getFullYear()} {t("appName")}
        </p>
      </aside>

      {/* ---- form side ---- */}
      <main className="relative flex min-h-screen flex-col">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(249,115,22,0.10),transparent)] lg:hidden"
        />
        <header className="relative flex items-center justify-between px-5 py-4 sm:px-8 sm:py-5">
          <Link to="/" className="flex items-center gap-2.5 text-[16px] font-semibold tracking-[-0.02em] lg:invisible">
            <img src="/brand/liveface-mark-512.png" alt="" width={32} height={32} className="h-8 w-8 rounded-[10px]" />
            {t("appName")}
          </Link>
          <div className="flex items-center gap-1">
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
          </div>
        </header>

        <div className="relative flex flex-1 items-center justify-center px-5 pb-12 pt-4 sm:px-8">
          <div className="w-full max-w-[380px]">
            {/* Phones get no brand panel; the face still says hello. */}
            <div className="mb-8 flex items-center gap-3 lg:hidden" aria-hidden="true">
              <span className="relative shrink-0">
                <span className="absolute -inset-1 rounded-full bg-brand-500/25 motion-safe:animate-ping" style={{ animationDuration: "2.6s" }} />
                <img
                  src={DEMO_PORTRAIT}
                  alt=""
                  width={48}
                  height={48}
                  className="relative h-12 w-12 rounded-full object-cover ring-2 ring-white dark:ring-ink"
                />
              </span>
              <p className="rounded-2xl rounded-ss-md bg-gray-100 px-3.5 py-2 text-[13px] leading-snug text-gray-700 dark:bg-white/[0.06] dark:text-gray-300">
                {t("authSpeakLine")}
              </p>
            </div>
            <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-gray-950 sm:text-[32px] dark:text-white">{title}</h1>
            {subtitle && <p className="mt-2 text-[15px] leading-relaxed text-gray-500 dark:text-gray-400">{subtitle}</p>}
            <div className="mt-8">{children}</div>
          </div>
        </div>

        <div className="relative pb-6 text-center">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-[13px] text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
          >
            <Icon name="arrow" className="h-3.5 w-3.5 rotate-180 rtl:rotate-0" />
            {t("backToSite")}
          </Link>
        </div>
      </main>
    </div>
  );
}
