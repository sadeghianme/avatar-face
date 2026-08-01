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
 * A mouth that actually moves.
 *
 * The product is lip-sync, so the hero should demonstrate lip-sync rather than
 * describe it. This is a small SVG face driven by the same idea as the engine —
 * a viseme track on a clock — which needs no avatar, no API key and no network.
 */
function HeroFace() {
  const [open, setOpen] = useState(0);
  const [wide, setWide] = useState(0.5);
  const [blink, setBlink] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Rough viseme rhythm: vowels hold, consonants are quick, pauses are still.
    const track = [
      [0.75, 0.4], [0.1, 0.5], [0.55, 0.8], [0.2, 0.5], [0.85, 0.35],
      [0.05, 0.5], [0.45, 0.75], [0.7, 0.4], [0.15, 0.5], [0, 0.5], [0, 0.5],
    ];
    let i = 0;
    const id = window.setInterval(() => {
      const [o, w] = track[i % track.length];
      setOpen(o);
      setWide(w);
      i++;
    }, 165);
    const blinkId = window.setInterval(() => {
      setBlink(1);
      window.setTimeout(() => setBlink(0), 130);
    }, 4200);
    return () => {
      clearInterval(id);
      clearInterval(blinkId);
    };
  }, []);

  const lipGap = 3 + open * 26;
  const mouthW = 46 + wide * 26;
  const lidY = 96 - blink * 9;

  return (
    <svg viewBox="0 0 240 260" className="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id="skin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f6d9c6" />
          <stop offset="100%" stopColor="#e7bda3" />
        </linearGradient>
        <linearGradient id="cavity" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7d3a37" />
          <stop offset="100%" stopColor="#a8564e" />
        </linearGradient>
      </defs>
      <ellipse cx="120" cy="130" rx="78" ry="98" fill="url(#skin)" />
      {/* eyes */}
      {[86, 154].map((x) => (
        <g key={x}>
          <ellipse cx={x} cy="104" rx="17" ry={Math.max(1.5, 11 - blink * 9)} fill="#fdfdfd" />
          <circle cx={x} cy="104" r={Math.max(1, 8 - blink * 6)} fill="#5b3a2b" />
          <circle cx={x} cy="104" r={Math.max(0.5, 3.4 - blink * 3)} fill="#20140f" />
          <circle cx={x - 3} cy="101" r={Math.max(0, 1.6 - blink * 1.6)} fill="#fff" />
          <path
            d={`M ${x - 19} ${lidY} Q ${x} ${lidY - 8} ${x + 19} ${lidY}`}
            stroke="#4a3226"
            strokeWidth="2.4"
            fill="none"
            strokeLinecap="round"
          />
        </g>
      ))}
      <path d="M 64 84 Q 86 74 108 82" stroke="#5c4033" strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d="M 132 82 Q 154 74 176 84" stroke="#5c4033" strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d="M 120 118 L 116 146 Q 120 150 124 146" stroke="#c99a80" strokeWidth="3" fill="none" strokeLinecap="round" />
      {/* mouth: the point of the whole thing */}
      <g style={{ transition: "all 110ms ease-out" }}>
        <ellipse cx="120" cy="182" rx={mouthW / 2} ry={lipGap / 2} fill="url(#cavity)" />
        {open > 0.35 && (
          <rect
            x={120 - mouthW / 4}
            y={182 - lipGap / 2 + 1}
            width={mouthW / 2}
            height={Math.min(5, lipGap * 0.22)}
            rx="1.5"
            fill="#fbf6f0"
          />
        )}
        <path
          d={`M ${120 - mouthW / 2} 182 Q 120 ${182 - lipGap / 2 - 7} ${120 + mouthW / 2} 182`}
          stroke="#c4746b"
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d={`M ${120 - mouthW / 2} 182 Q 120 ${182 + lipGap / 2 + 9} ${120 + mouthW / 2} 182`}
          stroke="#b9635c"
          strokeWidth="6"
          fill="none"
          strokeLinecap="round"
        />
      </g>
    </svg>
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
    <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-50">
      {/* ---- nav ---- */}
      <header className="sticky top-0 z-40 border-b border-gray-200/60 bg-white/70 backdrop-blur-xl dark:border-white/10 dark:bg-gray-950/70">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
          <Link to="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-fuchsia-500 text-white">
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
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_15%_0%,rgba(99,102,241,0.20),transparent),radial-gradient(50%_45%_at_85%_10%,rgba(217,70,239,0.18),transparent)]"
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
            <h1 className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
              {t("heroTitleA")}{" "}
              <span className="bg-gradient-to-r from-brand-500 via-violet-500 to-fuchsia-500 bg-clip-text text-transparent">
                {t("heroTitleB")}
              </span>
            </h1>
            <p className="mt-5 max-w-lg text-lg leading-relaxed text-gray-600 dark:text-gray-300">
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
            <div className="relative mx-auto aspect-square w-full max-w-sm">
              <div
                aria-hidden="true"
                className="absolute inset-0 rounded-[2rem] bg-gradient-to-br from-brand-500/25 to-fuchsia-500/25 blur-2xl"
              />
              <div className="relative h-full rounded-[2rem] border border-white/50 bg-white/70 p-6 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-white/5">
                <HeroFace />
                <div className="absolute inset-x-6 bottom-5 rounded-xl bg-gray-900/85 px-3 py-2 text-center text-xs text-emerald-300 backdrop-blur">
                  Liveface.speak(&quot;{t("heroDemoLine")}&quot;)
                </div>
              </div>
            </div>
          </Section>
        </div>
      </section>

      {/* ---- features ---- */}
      <section className="border-y border-gray-200 bg-gray-50/60 py-20 dark:border-white/10 dark:bg-white/[0.02]">
        <div className="mx-auto max-w-6xl px-5">
          <Section>
            <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
              {t("featuresTitle")}
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-center text-gray-600 dark:text-gray-300">
              {t("featuresSubtitle")}
            </p>
          </Section>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <Section key={f.key}>
                <div className="group h-full rounded-2xl border border-gray-200 bg-white p-6 transition hover:-translate-y-1 hover:border-brand-300 hover:shadow-lg dark:border-white/10 dark:bg-white/5 dark:hover:border-brand-500/40">
                  <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-brand-500/15 to-fuchsia-500/15 text-xl">
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
            <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
              {t("howTitle")}
            </h2>
          </Section>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {steps.map((key, i) => (
              <Section key={key}>
                <div className="relative h-full rounded-2xl border border-gray-200 p-6 dark:border-white/10">
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
      <section id="developers" className="border-y border-gray-200 bg-gray-50/60 py-20 dark:border-white/10 dark:bg-white/[0.02]">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 md:grid-cols-2">
          <Section>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{t("devTitle")}</h2>
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
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{t("ctaTitle")}</h2>
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

      <footer className="border-t border-gray-200 py-8 dark:border-white/10">
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
