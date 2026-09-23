import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { DemoAvatar, useDemo, VoiceMeter } from "@/components/brand/DemoAvatar";
import { DemoDirector, type DemoSnapshot } from "@/components/brand/demoDirector";
import { Icon } from "@/components/ui/Icon";
import { useAuth } from "@/providers/auth";

import { Reveal } from "./Reveal";

const LANGUAGE_NAMES: Record<string, string> = {
  "en-US": "English", "es-ES": "Español", "fr-FR": "Français", "hi-IN": "हिन्दी",
};

export function Hero() {
  const { t } = useTranslation();
  const { user } = useAuth();

  return (
    <section className="relative isolate overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(0,0,0,0.045)_1px,transparent_1px),linear-gradient(to_bottom,rgba(0,0,0,0.045)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_75%_65%_at_50%_20%,black,transparent)] dark:bg-[linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)]" />
        <div className="absolute -top-48 left-1/2 h-[560px] w-[1000px] -translate-x-1/2 rounded-full bg-brand-500/[0.18] blur-[130px] dark:bg-brand-500/[0.14]" />
      </div>

      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-14 px-5 pb-20 pt-10 sm:px-6 lg:grid-cols-[1.02fr_1fr] lg:gap-10 lg:pb-28 lg:pt-16">
        <div className="max-w-xl">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-white/70 px-3 py-1 text-[12.5px] font-medium text-brand-700 backdrop-blur dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-brand-500 opacity-75 motion-safe:animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" />
              </span>
              {t("heroBadge")}
            </span>
          </Reveal>
          <Reveal delay={60}>
            <h1 className="mt-6 text-balance text-[44px] font-semibold leading-[1.02] tracking-[-0.04em] text-gray-950 sm:text-[60px] lg:text-[68px] dark:text-white">
              {t("heroTitleA")}{" "}
              <span className="bg-gradient-to-br from-brand-400 via-brand-500 to-brand-700 bg-clip-text text-transparent">
                {t("heroTitleB")}
              </span>
            </h1>
          </Reveal>
          <Reveal delay={120}>
            <p className="mt-6 max-w-lg text-pretty text-[18px] leading-[1.6] text-gray-600 dark:text-gray-400">
              {t("heroSubtitle")}
            </p>
          </Reveal>
          <Reveal delay={180}>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link
                to={user ? "/app" : "/register"}
                className="btn-primary group rounded-full px-6 py-3.5 text-[15px] shadow-[0_10px_30px_-10px_rgba(234,106,12,0.7)]"
              >
                {user ? t("openDashboard") : t("heroCtaPrimary")}
                <Icon name="arrow" className="h-4 w-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180" />
              </Link>
              <a href="#how" className="btn-secondary rounded-full px-6 py-3.5 text-[15px]">
                {t("heroCtaSecondary")}
              </a>
            </div>
          </Reveal>
          <Reveal delay={240}>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2.5 text-[13.5px] text-gray-600 dark:text-gray-400">
              {["heroPoint1", "heroPoint2", "heroPoint3"].map((key) => (
                <li key={key} className="flex items-center gap-2">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400">
                    <Icon name="check" className="h-3 w-3" strokeWidth={2.4} />
                  </span>
                  {t(key)}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>

        <Reveal delay={120}>
          <HeroStage />
        </Reveal>
      </div>
    </section>
  );
}

/**
 * The product itself, running: the real engine on a fictional portrait,
 * speaking lines recorded with the real voices, framed by the platform steps
 * that made it — rig, voice, mouth shape, embed.
 */
function HeroStage() {
  const { t } = useTranslation();
  const [director] = useState(() => new DemoDirector());
  useEffect(() => () => director.stop(), [director]);
  const demo = useDemo(director);

  return (
    <div className="relative mx-auto w-full max-w-[520px] lg:me-2">
      <div
        aria-hidden="true"
        className="absolute -inset-10 -z-10 rounded-[3rem] bg-gradient-to-br from-brand-400/35 via-brand-500/15 to-transparent blur-3xl motion-safe:animate-glow"
      />
      <div className="relative overflow-hidden rounded-[30px] border border-black/[0.06] bg-gray-100 shadow-[0_50px_120px_-40px_rgba(234,106,12,0.55),0_20px_50px_-30px_rgba(0,0,0,0.35)] dark:border-white/[0.08] dark:bg-panel">
        <DemoAvatar
          mode="showcase"
          director={director}
          label={t("stageAvatarLabel")}
          playLabel={t("stagePlay")}
          className="w-full"
        />

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-4">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-white backdrop-blur-md">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 motion-safe:animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
            </span>
            {t("stageLive")}
          </span>
          <SoundToggle director={director} soundOn={demo.soundOn} />
        </div>

        <Caption demo={demo} director={director} />
      </div>

      <StageChips demo={demo} />
    </div>
  );
}

function SoundToggle({ director, soundOn }: { director: DemoDirector; soundOn: boolean }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => director.setSound(!soundOn)}
      aria-pressed={soundOn}
      aria-label={soundOn ? t("soundOff") : t("soundOn")}
      title={soundOn ? t("soundOff") : t("soundOn")}
      className="pointer-events-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-black/45 px-3 text-[12px] font-medium text-white backdrop-blur-md transition hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
    >
      <Icon name={soundOn ? "speaker" : "mute"} className="h-4 w-4" />
      <span className="hidden sm:inline">{soundOn ? t("soundOnState") : t("soundOffState")}</span>
    </button>
  );
}

/** Live caption: the words already spoken are bright, the rest are dim. */
function Caption({ demo, director }: { demo: DemoSnapshot; director: DemoDirector }) {
  const { t } = useTranslation();
  const line = demo.line;
  const gloss = line ? t(`demoGloss${demo.lineIndex + 1}`) : "";
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/40 to-transparent px-5 pb-5 pt-20" aria-live="off">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11.5px] font-medium text-white backdrop-blur-md">
          <Icon name="globe" className="h-3.5 w-3.5" />
          {line ? `${LANGUAGE_NAMES[line.locale] ?? line.locale} · ${line.voiceName}` : t("stageVoiceIdle")}
        </span>
        <VoiceMeter director={director} bars={6} className="[&>span]:bg-white" />
      </div>
      <p
        dir="auto"
        lang={line?.locale}
        className="mt-2.5 min-h-[2.8em] text-[17px] font-medium leading-snug text-white sm:text-[18px]"
      >
        {line
          ? line.words.map((word, i) => (
              <span
                key={i}
                className={`transition-colors duration-150 ${i <= demo.wordIndex ? "text-white" : "text-white/40"}`}
              >
                {word.w}{" "}
              </span>
            ))
          : demo.phase === "scanning"
            ? t("stageScanning")
            : t("stageLoading")}
      </p>
      <p className="mt-1 min-h-[1.25em] text-[12.5px] italic text-white/60">{gloss}</p>
    </div>
  );
}

/** The platform around the face: each chip is a real step of the pipeline. */
function StageChips({ demo }: { demo: DemoSnapshot }) {
  const { t } = useTranslation();
  const chip =
    "pointer-events-none absolute hidden rounded-2xl border border-black/[0.06] bg-white/90 px-3.5 py-2.5 shadow-[0_18px_40px_-18px_rgba(0,0,0,0.35)] backdrop-blur-xl lg:block dark:border-white/[0.08] dark:bg-raised/90";
  return (
    <>
      {demo.rigged && (
        <div className={`${chip} -start-6 top-16 xl:-start-14 motion-safe:animate-tick-in`}>
          <div className="flex items-center gap-2.5 motion-safe:animate-float">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-400">
              <Icon name="target" className="h-4 w-4" />
            </span>
            <div>
              <p className="text-[12px] font-semibold text-gray-900 dark:text-white">{t("chipRigTitle")}</p>
              <p className="text-[11.5px] text-gray-500 dark:text-gray-400">{t("chipRigBody")}</p>
            </div>
          </div>
        </div>
      )}

      <div className={`${chip} -end-4 top-[36%] xl:-end-10`}>
        <div className="motion-safe:animate-float-slow">
          <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-gray-400">{t("chipVisemeTitle")}</p>
          <p className="mt-0.5 font-mono text-[22px] font-semibold leading-none text-brand-600 dark:text-brand-400">
            {demo.phase === "speaking" ? demo.viseme : "sil"}
          </p>
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">{t("chipVisemeBody")}</p>
        </div>
      </div>

      <div className={`${chip} -bottom-12 -start-6 xl:-start-12`}>
        <div className="motion-safe:animate-float" style={{ animationDelay: "1.2s" }}>
          <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-gray-400">{t("chipEmbedTitle")}</p>
          <p className="mt-1 font-mono text-[12px] text-gray-800 dark:text-gray-200">
            <span className="text-brand-600 dark:text-brand-400">&lt;script</span> src=&quot;…/liveface.js&quot;
            <span className="text-brand-600 dark:text-brand-400">&gt;</span>
            <span className="ms-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 bg-brand-500 motion-safe:animate-caret" />
          </p>
        </div>
      </div>

      <div className={`${chip} -end-3 -top-4 !rounded-full !px-3 !py-1.5 xl:-end-6`}>
        <p className="flex items-center gap-1.5 text-[12px] font-semibold text-emerald-700 dark:text-emerald-400">
          <Icon name="check" className="h-3.5 w-3.5" strokeWidth={2.4} />
          {t("chipPublished")}
        </p>
      </div>
    </>
  );
}
