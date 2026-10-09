import smileUrl from "@/assets/demo/smile.webp";
import { Icon, type IconName } from "@/components/ui/Icon";
import { LANGUAGES, OPENNESS } from "@/features/landing/data";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";

import { Reveal, SectionHeader } from "./Reveal";

const card = cx(
  "group relative flex h-full flex-col overflow-hidden rounded-3xl border border-black/[0.07] bg-white p-7",
  "transition duration-300 hover:border-brand-300/70 dark:border-white/[0.08] dark:bg-panel dark:hover:border-brand-500/30"
);

/** The four looks a portrait can take, each with its colour dot. */
const STYLES = [
  { key: "stylePhoto", dot: "bg-brand-500" },
  { key: "styleIllustrated", dot: "bg-violet-500" },
  { key: "styleAnime", dot: "bg-pink-500" },
  { key: "style3d", dot: "bg-sky-500" },
] as const;

/** A status strip that swaps with its twin (the publish mock). */
const SWAP_STRIP = "col-start-1 row-start-1 flex items-center rounded-2xl px-4 py-3 ring-1 motion-safe:animate-swap";

/** A small rounded tag on the grey visual panels. */
const TAG = cx(
  "rounded-full border border-black/[0.07] bg-gray-50 px-3 py-1.5 text-[13px] font-medium text-gray-700",
  "dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
);

function CardHead({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <>
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-400">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <h3 className="mt-5 text-[19px] font-semibold tracking-[-0.02em] text-gray-950 dark:text-white">{title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-gray-600 dark:text-gray-400">{body}</p>
    </>
  );
}

export function Features() {
  const { t } = useT();
  return (
    <section id="features" className="scroll-mt-20 bg-gray-50/70 py-24 sm:py-32 dark:bg-white/[0.015]">
      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <SectionHeader eyebrow={t("featuresEyebrow")} title={t("featuresTitle")} subtitle={t("featuresSubtitle")} />

        <div className="mt-16 grid grid-cols-1 gap-5 lg:grid-cols-6">
          <Reveal className="lg:col-span-4">
            <div className={card}>
              <CardHead icon="message" title={t("featLipsyncTitle")} body={t("featLipsyncBody")} />
              <LipSyncVisual />
            </div>
          </Reveal>
          <Reveal className="lg:col-span-2" delay={80}>
            <div className={card}>
              <CardHead icon="wave" title={t("featMotionTitle")} body={t("featMotionBody")} />
              <MotionVisual />
            </div>
          </Reveal>

          <Reveal className="lg:col-span-2">
            <div className={card}>
              <CardHead icon="globe" title={t("featVoicesTitle")} body={t("featVoicesBody")} />
              <VoicesVisual />
            </div>
          </Reveal>
          <Reveal className="lg:col-span-2" delay={80}>
            <div className={card}>
              <CardHead icon="sparkles" title={t("featMouthTitle")} body={t("featMouthBody")} />
              <div className="relative mt-auto overflow-hidden rounded-2xl pt-7">
                <img
                  src={smileUrl}
                  alt={t("featMouthAlt")}
                  loading="lazy"
                  decoding="async"
                  width={480}
                  height={298}
                  className="w-full rounded-2xl object-cover ring-1 ring-black/[0.06]"
                />
              </div>
            </div>
          </Reveal>
          <Reveal className="lg:col-span-2" delay={160}>
            <div className={card}>
              <CardHead icon="layers" title={t("featPublishTitle")} body={t("featPublishBody")} />
              <div className="relative mt-auto grid pt-7">
                <div
                  className={cx(
                    SWAP_STRIP,
                    "justify-between bg-amber-50 ring-amber-200 dark:bg-amber-500/10 dark:ring-amber-500/25"
                  )}
                >
                  <span className="text-[13px] font-medium text-amber-800 dark:text-amber-300">
                    {t("mockUnpublished")}
                  </span>
                  <span className="rounded-full bg-brand-600 px-3 py-1 text-[12px] font-semibold text-white">
                    {t("mockPublish")}
                  </span>
                </div>
                <div
                  className={cx(
                    SWAP_STRIP,
                    "gap-2 bg-emerald-50 opacity-0 ring-emerald-200 dark:bg-emerald-500/10 dark:ring-emerald-500/25"
                  )}
                  style={{ animationDelay: "-3s" }}
                >
                  <Icon name="check" className="h-4 w-4 text-emerald-600 dark:text-emerald-400" strokeWidth={2.4} />
                  <span className="text-[13px] font-medium text-emerald-800 dark:text-emerald-300">
                    {t("mockPublishedLive")}
                  </span>
                </div>
              </div>
            </div>
          </Reveal>

          <Reveal className="lg:col-span-6">
            <div className={cx(card, "lg:flex-row lg:items-center lg:gap-10")}>
              <div className="lg:max-w-md">
                <CardHead icon="image" title={t("featStylesTitle")} body={t("featStylesBody")} />
              </div>
              <ul className="mt-7 grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4 lg:mt-0">
                {STYLES.map((style) => (
                  <li
                    key={style.key}
                    className={cx(
                      "flex items-center gap-2.5 rounded-2xl border border-black/[0.06] bg-gray-50 px-4 py-3.5",
                      "text-[14px] font-medium text-gray-800 dark:border-white/[0.07] dark:bg-white/[0.03] dark:text-gray-200"
                    )}
                  >
                    <span className={cx("h-2.5 w-2.5 rounded-full", style.dot)} />
                    {t(style.key)}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/** The first demo line's measured mouth openness, with a playhead. */
function LipSyncVisual() {
  const { t } = useT();
  const tokens = ["ih", "aa", "PP", "E", "nn", "FF", "aa", "RR", "PP", "E", "DD"];
  return (
    <div className="mt-8 rounded-2xl border border-black/[0.06] bg-gray-50 p-5 dark:border-white/[0.06] dark:bg-white/[0.02]">
      <div className="flex items-center justify-between text-[12px]">
        <span className="font-medium text-gray-500 dark:text-gray-400">“{t("lipsyncSample")}”</span>
        <span className="shrink-0 whitespace-nowrap font-mono text-gray-400">3.1 s</span>
      </div>
      <div className="relative mt-4 flex h-24 items-center gap-[3px]" aria-hidden="true">
        {OPENNESS.map((v, i) => (
          <span
            key={i}
            className="flex-1 rounded-full bg-gradient-to-t from-brand-500 to-brand-300"
            style={{ height: `${Math.max(6, v * 100)}%`, opacity: 0.35 + v * 0.65 }}
          />
        ))}
        <span
          className={cx(
            "absolute inset-y-0 w-[2px] rounded-full bg-gray-900 motion-safe:animate-playhead dark:bg-white",
            "shadow-[0_0_0_3px_rgba(255,255,255,0.8)] dark:shadow-[0_0_0_3px_rgba(0,0,0,0.5)]"
          )}
        />
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5" aria-hidden="true">
        {tokens.map((token, i) => (
          <span
            key={i}
            className={cx(
              "rounded-md bg-white px-2 py-1 font-mono text-[11.5px] font-medium text-gray-600 ring-1 ring-black/[0.06]",
              "dark:bg-white/[0.05] dark:text-gray-300 dark:ring-white/10"
            )}
          >
            {token}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Where breath, blinks and nods fall around one spoken sentence. */
function MotionVisual() {
  const { t } = useT();
  const rows = [
    { key: "motionBreath", d: "M0 18 C 12 18, 14 4, 22 4 S 60 12, 100 16" },
    { key: "motionBlink", d: "M0 14 H30 L32 3 L34 14 H66 L68 3 L70 14 H100" },
    { key: "motionNod", d: "M0 10 H24 Q28 16 32 10 H54 Q58 16 62 10 H100" },
  ] as const;
  return (
    <div className="mt-auto space-y-3 pt-7">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-3">
          <span className="w-12 shrink-0 text-[12px] font-medium text-gray-500 dark:text-gray-400">{t(row.key)}</span>
          <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="h-6 flex-1" aria-hidden="true">
            <path
              d={row.d}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              vectorEffect="non-scaling-stroke"
              className="text-brand-500"
            />
          </svg>
        </div>
      ))}
    </div>
  );
}

/** Three of the real voices the demo speaks with, then every language. */
const VOICES = [
  { name: "Heart", language: "English" },
  { name: "Dora", language: "Español" },
  { name: "Siwis", language: "Français" },
];

function VoicesVisual() {
  return (
    <div className="mt-auto pt-7" aria-hidden="true">
      <ul className="space-y-2">
        {VOICES.map((voice, i) => {
          const active = i === 1;
          return (
            <li
              key={voice.name}
              className={cx(
                "flex items-center gap-3 rounded-xl px-3 py-2 ring-1",
                active
                  ? "bg-brand-500/[0.07] ring-brand-500/25"
                  : "bg-gray-50 ring-black/[0.05] dark:bg-white/[0.03] dark:ring-white/[0.06]"
              )}
            >
              <span
                className={cx(
                  "grid h-7 w-7 shrink-0 place-items-center rounded-full",
                  active
                    ? "bg-brand-500 text-white"
                    : "bg-white text-gray-500 ring-1 ring-black/[0.06] dark:bg-white/[0.06] dark:text-gray-300 dark:ring-white/10"
                )}
              >
                <Icon name={active ? "speaker" : "playTriangle"} className="h-3.5 w-3.5" />
              </span>
              <span className="text-[13.5px] font-semibold text-gray-900 dark:text-white">{voice.name}</span>
              <span className="truncate text-[13px] text-gray-500 dark:text-gray-400">{voice.language}</span>
              {active && (
                <span className="ms-auto flex h-4 items-end gap-[3px]">
                  {[0.5, 0.9, 0.65, 1, 0.45].map((h, k) => (
                    <span
                      key={k}
                      className="w-[3px] origin-bottom rounded-full bg-brand-500 motion-safe:animate-eq"
                      style={{ height: `${h * 100}%`, animationDelay: `${k * -0.17}s` }}
                    />
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="relative -mx-7 mt-4 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
        <div className="flex w-max gap-2 motion-safe:animate-marquee">
          {[...LANGUAGES, ...LANGUAGES].map((name, i) => (
            <span key={i} dir="auto" className={TAG}>
              {name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
