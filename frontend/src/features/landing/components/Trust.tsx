import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "@/components/ui/Icon";

import { Reveal } from "./Reveal";

const ITEMS: { icon: IconName; key: string }[] = [
  { icon: "lock", key: "trustKeys" },
  { icon: "users", key: "trustOrg" },
  { icon: "layers", key: "trustPublish" },
  { icon: "shield", key: "trustConsent" },
];

export function Trust() {
  const { t } = useTranslation();
  return (
    <section id="security" className="scroll-mt-20 border-y border-black/[0.06] bg-gray-950 py-24 text-white sm:py-28 dark:border-white/[0.07]">
      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <Reveal className="max-w-2xl">
          <p className="text-[13px] font-semibold uppercase tracking-[0.14em] text-brand-400">{t("trustEyebrow")}</p>
          <h2 className="mt-3 text-balance text-[32px] font-semibold leading-[1.1] tracking-[-0.03em] sm:text-[42px]">
            {t("trustTitle")}
          </h2>
        </Reveal>
        <ul className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-3xl bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
          {ITEMS.map((item, i) => (
            // The cell keeps its background while its content fades in, so
            // the 1px grid lines never show through as a grey block.
            <li key={item.key} className="bg-gray-950">
              <Reveal delay={i * 70} className="h-full p-7">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/[0.07] text-brand-400 ring-1 ring-white/10">
                  <Icon name={item.icon} className="h-5 w-5" />
                </span>
                <h3 className="mt-5 text-[16.5px] font-semibold">{t(`${item.key}Title`)}</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-gray-400">{t(`${item.key}Body`)}</p>
              </Reveal>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
