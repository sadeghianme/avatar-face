import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { useAuth } from "../lib/auth";

/** Reveal on scroll. Cheap, and it keeps a long page from arriving all at once. */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Respect a user who has asked for less motion: show it immediately.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => entry.isIntersecting && setShown(true),
      { rootMargin: "-60px" }
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);
  return { ref, className: shown ? "reveal reveal-in" : "reveal" };
}

function Section({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const reveal = useReveal<HTMLDivElement>();
  return (
    <div ref={reveal.ref} className={`${reveal.className} ${className}`}>
      {children}
    </div>
  );
}

/**
 * The product in context, rather than a drawing of a face.
 *
 * An earlier version drew a cartoon face here to demonstrate lip-sync. It
 * looked cheap, and a crude face on the landing page of a product about
 * faces undersells the thing it is advertising. A browser frame showing the
 * widget actually embedded says more and promises less.
 */
function HeroDemo() {
  const { t } = useTranslation();
  const [level, setLevel] = useState<number[]>(() => Array(28).fill(0.15));
  const [caption, setCaption] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // A speaking envelope: syllable-rate peaks with quiet between phrases,
    // not a uniform dance — it should read as speech, not as a music player.
    let t = 0;
    const id = window.setInterval(() => {
      t += 1;
      setLevel((prev) => {
        const next = prev.slice(1);
        const phrase = Math.sin(t / 34) > -0.35;
        const syllable = Math.abs(Math.sin(t / 2.1)) ** 1.6;
        next.push(phrase ? 0.12 + syllable * 0.88 : 0.06);
        return next;
      });
    }, 55);
    const capId = window.setInterval(() => setCaption((c) => (c + 1) % 3), 3400);
    return () => {
      clearInterval(id);
      clearInterval(capId);
    };
  }, []);

  const lines = ["heroDemoLine1", "heroDemoLine2", "heroDemoLine3"];

  return (
    <div className="overflow-hidden rounded-2xl border border-white/50 bg-white/80 shadow-2xl backdrop-blur-xl dark:border-line dark:bg-white/[0.06]">
      {/* browser chrome */}
      <div className="flex items-center gap-2 border-b border-gray-200/70 px-4 py-3 dark:border-line">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-yellow-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-400" />
        <span className="ms-3 truncate rounded-md bg-gray-100 px-3 py-1 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
          yoursite.com
        </span>
      </div>

      <div className="space-y-4 p-5">
        {/* the widget, sitting on someone's page */}
        <div className="flex items-center gap-4 rounded-xl bg-gradient-to-br from-brand-500/10 to-brand-600/5 p-4">
          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full bg-gradient-to-br from-brand-400 to-brand-600">
            <span className="absolute inset-0 grid place-items-center text-2xl">🙂</span>
            <span className="absolute inset-x-0 bottom-0 h-1.5 bg-emerald-400/90" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex h-10 items-end gap-[3px]" aria-hidden="true">
              {level.map((v, i) => (
                <span
                  key={i}
                  className="flex-1 rounded-full bg-brand-500/80"
                  style={{ height: `${Math.max(8, v * 100)}%`, transition: "height 70ms linear" }}
                />
              ))}
            </div>
            <p className="mt-1.5 truncate text-xs text-gray-600 dark:text-gray-300">
              {t(lines[caption])}
            </p>
          </div>
        </div>

        <pre className="overflow-x-auto rounded-xl bg-gray-900 p-3.5 text-[11px] leading-relaxed text-emerald-300">
{`<script src=".../liveface.js"
  data-avatar="a1b2c3" data-key="pk_live_…"></script>`}
        </pre>
      </div>
    </div>
  );
}

const SNIPPET = `<script
  src="https://avatar.mehdisadeghian.com/api/liveface.js"
  data-avatar="YOUR_AVATAR_ID"
  data-key="YOUR_API_KEY"
></script>
<script>Liveface.speak("Hello there!")</script>`;

export function LandingPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);

  const features = [
    { icon: "🗣", key: "featLipsync" },
    { icon: "⚡", key: "featEmbed" },
    { icon: "🎨", key: "featAnyFace" },
    { icon: "🌍", key: "featVoices" },
    { icon: "🧩", key: "featApi" },
    { icon: "🔒", key: "featPrivate" },
  ];

  const steps = ["stepUpload", "stepTune", "stepEmbed"];

  return (
    <div className="min-h-screen bg-white text-gray-900 dark:bg-ink dark:text-gray-50">
      {/* ---- nav ---- */}
      <header className="sticky top-0 z-40 border-b border-gray-200/60 bg-white/70 backdrop-blur-xl dark:border-line dark:bg-ink/70">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
          <Link to="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-white">
              ◕
            </span>
            {t("appName")}
          </Link>
          <div className="flex items-center gap-2">
            <a href="#how" className="hidden px-3 py-2 text-sm text-gray-600 hover:text-gray-900 sm:block dark:text-gray-300 dark:hover:text-white">
              {t("navHow")}
            </a>
            <a href="#developers" className="hidden px-3 py-2 text-sm text-gray-600 hover:text-gray-900 sm:block dark:text-gray-300 dark:hover:text-white">
              {t("navDevelopers")}
            </a>
            {user ? (
              <Link to="/app" className="btn-primary">
                {t("openDashboard")}
              </Link>
            ) : (
              <>
                <Link to="/login" className="btn-secondary">
                  {t("login")}
                </Link>
                <Link to="/register" className="btn-primary">
                  {t("getStarted")}
                </Link>
              </>
            )}
          </div>
        </nav>
      </header>

      {/* ---- hero ---- */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_15%_0%,rgba(249,115,22,0.16),transparent),radial-gradient(50%_45%_at_85%_10%,rgba(249,115,22,0.14),transparent)]"
        />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-16 md:grid-cols-2 md:pb-28 md:pt-24">
          <Section>
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" />
              </span>
              {t("heroBadge")}
            </span>
            <h1 className="mt-6 text-[42px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-[56px] lg:text-[64px]">
              {t("heroTitleA")}{" "}
              <span className="bg-gradient-to-r from-brand-500 to-brand-600 bg-clip-text text-transparent">
                {t("heroTitleB")}
              </span>
            </h1>
            <p className="mt-5 max-w-md text-[17px] leading-[1.5] text-gray-500 dark:text-gray-400">
              {t("heroSubtitle")}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to={user ? "/app" : "/register"} className="btn-primary px-6 py-3 text-base">
                {user ? t("openDashboard") : t("createFreeAvatar")}
              </Link>
              <a href="#developers" className="btn-secondary px-6 py-3 text-base">
                {t("seeTheCode")}
              </a>
            </div>
            <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">{t("heroFinePrint")}</p>
          </Section>

          <Section className="relative">
            <div className="relative mx-auto w-full max-w-md">
              <div
                aria-hidden="true"
                className="absolute -inset-6 rounded-[2rem] bg-gradient-to-br from-brand-500/25 to-brand-600/20 blur-3xl"
              />
              <div className="relative">
                <HeroDemo />
              </div>
            </div>
          </Section>
        </div>
      </section>

      {/* ---- features ---- */}
      <section className="border-y border-gray-200 bg-gray-50/60 py-20 dark:border-line dark:bg-white/[0.02]">
        <div className="mx-auto max-w-6xl px-5">
          <Section>
            <h2 className="text-center text-[32px] font-semibold tracking-[-0.03em] sm:text-[40px]">
              {t("featuresTitle")}
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-center text-gray-600 dark:text-gray-300">
              {t("featuresSubtitle")}
            </p>
          </Section>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <Section key={f.key}>
                <div className="group h-full rounded-2xl border border-gray-200 bg-white p-6 transition hover:-translate-y-1 hover:border-brand-300 hover:shadow-lg dark:border-line dark:bg-white/5 dark:hover:border-brand-500/40">
                  <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-brand-500/15 to-brand-600/10 text-xl">
                    {f.icon}
                  </div>
                  <h3 className="mt-4 font-semibold">{t(`${f.key}Title`)}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                    {t(`${f.key}Body`)}
                  </p>
                </div>
              </Section>
            ))}
          </div>
        </div>
      </section>

      {/* ---- how it works ---- */}
      <section id="how" className="py-20">
        <div className="mx-auto max-w-6xl px-5">
          <Section>
            <h2 className="text-center text-[32px] font-semibold tracking-[-0.03em] sm:text-[40px]">
              {t("howTitle")}
            </h2>
          </Section>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {steps.map((key, i) => (
              <Section key={key}>
                <div className="relative h-full rounded-2xl border border-gray-200 p-6 dark:border-line">
                  <div className="mb-4 grid h-9 w-9 place-items-center rounded-full bg-brand-600 text-sm font-bold text-white">
                    {i + 1}
                  </div>
                  <h3 className="font-semibold">{t(`${key}Title`)}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                    {t(`${key}Body`)}
                  </p>
                </div>
              </Section>
            ))}
          </div>
        </div>
      </section>

      {/* ---- developers ---- */}
      <section id="developers" className="border-y border-gray-200 bg-gray-50/60 py-20 dark:border-line dark:bg-white/[0.02]">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 md:grid-cols-2">
          <Section>
            <h2 className="text-[32px] font-semibold tracking-[-0.03em] sm:text-[40px]">{t("devTitle")}</h2>
            <p className="mt-4 leading-relaxed text-gray-600 dark:text-gray-300">{t("devBody")}</p>
            <ul className="mt-6 space-y-3 text-sm">
              {["devPoint1", "devPoint2", "devPoint3"].map((k) => (
                <li key={k} className="flex gap-3">
                  <span className="mt-0.5 text-brand-600 dark:text-brand-400">✓</span>
                  <span className="text-gray-700 dark:text-gray-200">{t(k)}</span>
                </li>
              ))}
            </ul>
          </Section>
          <Section>
            <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900 shadow-2xl">
              <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
                <span className="h-3 w-3 rounded-full bg-red-400" />
                <span className="h-3 w-3 rounded-full bg-yellow-400" />
                <span className="h-3 w-3 rounded-full bg-green-400" />
                <button
                  className="ms-auto rounded px-2 py-0.5 text-xs text-gray-300 hover:bg-white/10"
                  onClick={() => {
                    void navigator.clipboard.writeText(SNIPPET);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? t("copied") : t("copy")}
                </button>
              </div>
              <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-emerald-300">
                {SNIPPET}
              </pre>
            </div>
          </Section>
        </div>
      </section>

      {/* ---- cta ---- */}
      <section className="py-24">
        <Section>
          <div className="mx-auto max-w-3xl px-5 text-center">
            <h2 className="text-[32px] font-semibold tracking-[-0.03em] sm:text-[40px]">{t("ctaTitle")}</h2>
            <p className="mt-4 text-gray-600 dark:text-gray-300">{t("ctaBody")}</p>
            <Link
              to={user ? "/app" : "/register"}
              className="btn-primary mt-8 px-7 py-3 text-base"
            >
              {user ? t("openDashboard") : t("createFreeAvatar")}
            </Link>
          </div>
        </Section>
      </section>

      <footer className="border-t border-gray-200 py-8 dark:border-line">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-5 text-sm text-gray-500 sm:flex-row dark:text-gray-400">
          <span>
            © {new Date().getFullYear()} {t("appName")}
          </span>
          <div className="flex gap-5">
            <Link to="/login" className="hover:text-gray-900 dark:hover:text-white">
              {t("login")}
            </Link>
            <Link to="/register" className="hover:text-gray-900 dark:hover:text-white">
              {t("register")}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
