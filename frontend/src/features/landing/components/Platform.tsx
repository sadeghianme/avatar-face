import { useTranslation } from "react-i18next";

import { DEMO_PORTRAIT } from "@/components/brand/DemoAvatar";
import { Icon, type IconName } from "@/components/ui/Icon";

import { Reveal, SectionHeader } from "./Reveal";

const POINTS: { icon: IconName; key: string }[] = [
  { icon: "users", key: "platformTeam" },
  { icon: "key", key: "platformKeys" },
  { icon: "link", key: "platformShare" },
  { icon: "chart", key: "platformUsage" },
];

export function Platform() {
  const { t } = useTranslation();
  return (
    <section id="platform" className="scroll-mt-20 overflow-x-clip py-24 sm:py-32">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-16 px-5 sm:px-6 lg:grid-cols-[1fr_1.1fr]">
        <div>
          <SectionHeader
            align="start"
            eyebrow={t("platformEyebrow")}
            title={t("platformTitle")}
            subtitle={t("platformSubtitle")}
          />
          <ul className="mt-10 grid grid-cols-1 gap-x-8 gap-y-8 sm:grid-cols-2">
            {POINTS.map((point, i) => (
              <Reveal as="li" key={point.key} delay={i * 70}>
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-gray-900 text-white dark:bg-white dark:text-gray-900">
                  <Icon name={point.icon} className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-[16px] font-semibold text-gray-950 dark:text-white">
                  {t(`${point.key}Title`)}
                </h3>
                <p className="mt-1.5 text-[14.5px] leading-relaxed text-gray-600 dark:text-gray-400">
                  {t(`${point.key}Body`)}
                </p>
              </Reveal>
            ))}
          </ul>
        </div>
        <Reveal delay={100}>
          <DashboardMock />
        </Reveal>
      </div>
    </section>
  );
}

/** An illustration of the avatar page, built from the dashboard's own parts. */
function DashboardMock() {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className="absolute -inset-8 -z-10 rounded-[3rem] bg-gradient-to-tr from-brand-500/15 via-transparent to-brand-300/20 blur-3xl"
      />
      <div
        role="img"
        aria-label={t("mockLabel")}
        className="overflow-hidden rounded-3xl border border-black/[0.08] bg-white shadow-[0_40px_100px_-40px_rgba(0,0,0,0.4)] dark:border-white/[0.08] dark:bg-panel"
      >
        <div className="flex items-center gap-1.5 border-b border-black/[0.06] bg-gray-50/80 px-4 py-3 dark:border-white/[0.06] dark:bg-white/[0.02]">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          <span className="ms-3 text-[12px] font-medium text-gray-500 dark:text-gray-400">
            {t("appName")} · {t("mockAvatars")}
          </span>
        </div>

        <div className="grid">
          <div className="col-start-1 row-start-1 flex items-center justify-between border-b border-amber-200/70 bg-amber-50 px-5 py-2.5 motion-safe:animate-swap dark:border-amber-500/20 dark:bg-amber-500/10">
            <span className="text-[12.5px] font-medium text-amber-800 dark:text-amber-300">{t("mockUnpublished")}</span>
            <span className="rounded-full bg-brand-600 px-3 py-1 text-[11.5px] font-semibold text-white">
              {t("mockPublish")}
            </span>
          </div>
          <div
            className="col-start-1 row-start-1 flex items-center gap-2 border-b border-emerald-200/70 bg-emerald-50 px-5 py-2.5 opacity-0 motion-safe:animate-swap dark:border-emerald-500/20 dark:bg-emerald-500/10"
            style={{ animationDelay: "-3s" }}
          >
            <Icon name="check" className="h-4 w-4 text-emerald-600 dark:text-emerald-400" strokeWidth={2.4} />
            <span className="text-[12.5px] font-medium text-emerald-800 dark:text-emerald-300">
              {t("mockPublishedLive")}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-[180px_1fr]">
          <div className="relative overflow-hidden rounded-2xl">
            <img
              src={DEMO_PORTRAIT}
              alt=""
              loading="lazy"
              decoding="async"
              className="aspect-square w-full object-cover"
            />
            <span className="absolute bottom-2 start-2 rounded-full bg-black/55 px-2 py-0.5 text-[10.5px] font-semibold text-white backdrop-blur">
              {t("mockAvatarName")}
            </span>
          </div>
          <dl className="space-y-3 text-[13px]">
            {[
              { k: "mockVoice", v: t("mockVoiceValue") },
              { k: "mockMouth", v: t("mockMouthValue") },
            ].map((row) => (
              <div
                key={row.k}
                className="flex items-center justify-between rounded-xl bg-gray-50 px-3.5 py-2.5 ring-1 ring-black/[0.05] dark:bg-white/[0.03] dark:ring-white/[0.06]"
              >
                <dt className="text-gray-500 dark:text-gray-400">{t(row.k)}</dt>
                <dd className="font-medium text-gray-900 dark:text-white">{row.v}</dd>
              </div>
            ))}
            <div className="flex items-center justify-between rounded-xl bg-gray-50 px-3.5 py-2.5 ring-1 ring-black/[0.05] dark:bg-white/[0.03] dark:ring-white/[0.06]">
              <dt className="text-gray-500 dark:text-gray-400">{t("mockShare")}</dt>
              <dd>
                <span className="relative inline-flex h-5 w-9 items-center rounded-full bg-brand-500 p-0.5">
                  <span className="ms-auto h-4 w-4 rounded-full bg-white shadow" />
                </span>
              </dd>
            </div>
            <div className="rounded-xl bg-gray-50 px-3.5 py-3 ring-1 ring-black/[0.05] dark:bg-white/[0.03] dark:ring-white/[0.06]">
              <div className="flex justify-between">
                <dt className="text-gray-500 dark:text-gray-400">{t("mockUsage")}</dt>
                <dd className="font-mono text-[12px] text-gray-500 dark:text-gray-400">38%</dd>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">
                <div
                  className="h-full origin-left rounded-full bg-gradient-to-r from-brand-400 to-brand-600 motion-safe:animate-fill rtl:origin-right"
                  style={{ ["--fill" as string]: "0.38", transform: "scaleX(0.38)" }}
                />
              </div>
            </div>
          </dl>
        </div>

        <div className="border-t border-black/[0.06] bg-gray-950 px-5 py-3.5 font-mono text-[11.5px] text-gray-300 dark:border-white/[0.06]">
          <span className="text-brand-400">&lt;script</span> src=&quot;…/liveface.js&quot;
          data-avatar=&quot;a1b2c3&quot;
          <span className="text-brand-400">&gt;&lt;/script&gt;</span>
        </div>
      </div>
    </div>
  );
}
