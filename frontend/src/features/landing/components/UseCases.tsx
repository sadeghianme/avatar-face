import { Icon, type IconName } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";

import { Reveal, SectionHeader } from "./Reveal";

const CASES = [
  { icon: "headset", key: "useSupport" },
  { icon: "trending", key: "useSales" },
  { icon: "school", key: "useEdu" },
  { icon: "globe", key: "useGlobal" },
] as const satisfies readonly { icon: IconName; key: string }[];

/** A use case: lifts and warms under the pointer. */
const CASE_CARD = cx(
  "group h-full rounded-3xl border border-black/[0.07] bg-white p-7 transition duration-300 dark:border-white/[0.08] dark:bg-panel",
  "hover:-translate-y-1 hover:border-brand-300/70 hover:shadow-[0_30px_60px_-35px_rgba(234,106,12,0.5)] dark:hover:border-brand-500/30"
);

const CASE_ICON = cx(
  "grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white",
  "shadow-[0_10px_25px_-10px_rgba(234,106,12,0.8)]"
);

export function UseCases() {
  const { t } = useT();
  return (
    <section id="use-cases" className="scroll-mt-20 bg-gray-50/70 py-24 sm:py-32 dark:bg-white/[0.015]">
      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <SectionHeader eyebrow={t("useEyebrow")} title={t("useTitle")} />
        <ul className="mt-16 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {CASES.map((item, i) => (
            <Reveal as="li" key={item.key} delay={i * 70}>
              <div className={CASE_CARD}>
                <span className={CASE_ICON}>
                  <Icon name={item.icon} className="h-5 w-5" />
                </span>
                <h3 className="mt-6 text-[18px] font-semibold tracking-[-0.02em] text-gray-950 dark:text-white">
                  {t(`${item.key}Title`)}
                </h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-gray-600 dark:text-gray-400">
                  {t(`${item.key}Body`)}
                </p>
              </div>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
