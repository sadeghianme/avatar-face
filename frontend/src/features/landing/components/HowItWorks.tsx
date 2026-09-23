import { useTranslation } from "react-i18next";

import { DEMO_PORTRAIT } from "@/components/brand/DemoAvatar";
import { Icon } from "@/components/ui/Icon";

import { FACE_PATHS } from "@/features/landing/data";
import { Reveal, SectionHeader } from "./Reveal";

export function HowItWorks() {
  const { t } = useTranslation();
  const steps = [
    { key: "step1", visual: <PhotoVisual /> },
    { key: "step2", visual: <VoiceVisual /> },
    { key: "step3", visual: <EmbedVisual /> },
  ];
  return (
    <section id="how" className="scroll-mt-20 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <SectionHeader eyebrow={t("howEyebrow")} title={t("howTitle")} subtitle={t("howSubtitle")} />
        <ol className="mt-16 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {steps.map((step, i) => (
            <Reveal as="li" key={step.key} delay={i * 90}>
              <div className="group flex h-full flex-col overflow-hidden rounded-3xl border border-black/[0.07] bg-white transition duration-300 hover:-translate-y-1 hover:shadow-[0_30px_60px_-30px_rgba(0,0,0,0.3)] dark:border-white/[0.08] dark:bg-panel">
                <div className="relative aspect-[16/10] overflow-hidden border-b border-black/[0.06] bg-gradient-to-br from-gray-50 to-gray-100 dark:border-white/[0.06] dark:from-white/[0.03] dark:to-white/[0.01]">
                  {step.visual}
                </div>
                <div className="flex flex-1 flex-col p-7">
                  <span className="text-[13px] font-semibold text-brand-600 dark:text-brand-400">
                    {t("stepLabel", { n: i + 1 })}
                  </span>
                  <h3 className="mt-2 text-[21px] font-semibold tracking-[-0.02em] text-gray-950 dark:text-white">
                    {t(`${step.key}Title`)}
                  </h3>
                  <p className="mt-2.5 text-[15px] leading-relaxed text-gray-600 dark:text-gray-400">{t(`${step.key}Body`)}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** The demo photo with its own detected face outline drawing itself on. */
function PhotoVisual() {
  return (
    <div className="absolute inset-0 grid place-items-center">
      <div className="relative h-[82%] overflow-hidden rounded-2xl shadow-lg ring-1 ring-black/10" style={{ aspectRatio: "1 / 1" }}>
        <img src={DEMO_PORTRAIT} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden="true">
          {FACE_PATHS.map((d, i) => (
            <path
              key={i}
              d={d}
              pathLength={1}
              fill="none"
              stroke="rgb(251 139 60)"
              strokeWidth={0.55}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="1 1"
              className="motion-safe:animate-draw"
              style={{ animationDelay: `${i * 120}ms` }}
            />
          ))}
        </svg>
        <div className="absolute inset-x-0 top-0 h-full motion-safe:animate-scan">
          <div className="h-10 bg-gradient-to-b from-transparent to-brand-500/35" />
          <div className="h-[2px] bg-brand-400 shadow-[0_0_12px_rgba(249,115,22,0.9)]" />
        </div>
      </div>
    </div>
  );
}

function VoiceVisual() {
  const { t } = useTranslation();
  const languages = ["English", "Español", "Français", "हिन्दी"];
  return (
    <div className="absolute inset-0 flex flex-col justify-center gap-3 px-8">
      <div className="flex flex-wrap gap-2">
        {languages.map((name, i) => (
          <span
            key={name}
            className={`rounded-full px-3 py-1.5 text-[12.5px] font-medium ring-1 ${
              i === 1
                ? "bg-brand-500 text-white ring-brand-500"
                : "bg-white text-gray-700 ring-black/10 dark:bg-white/[0.06] dark:text-gray-200 dark:ring-white/10"
            }`}
          >
            {name}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-3 rounded-2xl bg-white p-3 ring-1 ring-black/[0.07] dark:bg-white/[0.05] dark:ring-white/10">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400">
          <Icon name="speaker" className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-gray-900 dark:text-white">Dora · Español</p>
          <div className="mt-1.5 flex h-3 items-end gap-[3px]" aria-hidden="true">
            {[0.4, 0.8, 0.55, 1, 0.35, 0.7, 0.9, 0.45, 0.6, 0.3, 0.75, 0.5].map((h, i) => (
              <span key={i} className="w-[3px] rounded-full bg-brand-400" style={{ height: `${h * 100}%` }} />
            ))}
          </div>
        </div>
        <span className="relative inline-grid h-8 min-w-[92px] place-items-center rounded-full bg-gray-900 px-3 text-[12px] font-semibold text-white dark:bg-white dark:text-gray-900">
          <span className="col-start-1 row-start-1 motion-safe:animate-swap">{t("stepVisualPublish")}</span>
          <span
            className="col-start-1 row-start-1 flex items-center gap-1 text-emerald-300 opacity-0 motion-safe:animate-swap dark:text-emerald-600"
            style={{ animationDelay: "-3s" }}
          >
            <Icon name="check" className="h-3.5 w-3.5" strokeWidth={2.4} />
            {t("stepVisualPublished")}
          </span>
        </span>
      </div>
    </div>
  );
}

function EmbedVisual() {
  const { t } = useTranslation();
  return (
    <div className="absolute inset-0 grid place-items-center px-6">
      <div className="w-full overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-black/10 dark:bg-[#101010] dark:ring-white/10">
        <div className="flex items-center gap-1.5 border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.06]">
          <span className="h-2 w-2 rounded-full bg-red-400" />
          <span className="h-2 w-2 rounded-full bg-amber-400" />
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          <span className="ms-2 truncate rounded bg-gray-100 px-2 py-0.5 text-[10.5px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
            yoursite.com
          </span>
        </div>
        <div className="relative space-y-2 p-3.5 font-mono text-[11px] leading-relaxed">
          <p className="text-gray-400">&lt;!-- {t("stepVisualComment")} --&gt;</p>
          <p
            className="overflow-hidden whitespace-nowrap text-gray-800 motion-safe:animate-type dark:text-gray-200"
            style={{ ["--type-width" as string]: "34ch", width: "34ch" }}
          >
            <span className="text-brand-600 dark:text-brand-400">&lt;script</span> src=&quot;…/liveface.js&quot;&gt;
          </p>
          <div className="flex items-center gap-2 pt-1 text-[11.5px] font-sans font-medium text-emerald-600 dark:text-emerald-400">
            <Icon name="check" className="h-3.5 w-3.5" strokeWidth={2.4} />
            {t("stepVisualLive")}
          </div>
          <img
            src={DEMO_PORTRAIT}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute bottom-3 end-3 h-14 w-14 rounded-full object-cover shadow-lg ring-2 ring-white motion-safe:animate-float dark:ring-[#101010]"
          />
        </div>
      </div>
    </div>
  );
}
