import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Icon } from "@/components/ui/Icon";

import { Reveal, SectionHeader } from "./Reveal";

const QUESTIONS = ["faqPhoto", "faqCode", "faqLanguages", "faqChat", "faqMobile", "faqEdit", "faqPrivacy", "faqFree"];

export function Faq() {
  const { t } = useTranslation();
  return (
    <section id="faq" className="scroll-mt-20 py-24 sm:py-32">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-12 px-5 sm:px-6 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <SectionHeader align="start" eyebrow={t("faqEyebrow")} title={t("faqTitle")} subtitle={t("faqSubtitle")} />
          <Reveal delay={80}>
            <Link to="/register" className="mt-8 inline-flex items-center gap-1.5 text-[15px] font-semibold text-brand-600 coarse:min-h-11 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300">
              {t("faqCta")}
              <Icon name="arrow" className="h-4 w-4 rtl:rotate-180" />
            </Link>
          </Reveal>
        </div>
        <Reveal delay={60}>
          <div className="divide-y divide-black/[0.07] border-y border-black/[0.07] dark:divide-white/[0.08] dark:border-white/[0.08]">
            {QUESTIONS.map((key) => (
              <details key={key} className="group py-1">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 rounded-lg py-4 text-start text-[16.5px] font-medium text-gray-950 marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 dark:text-white [&::-webkit-details-marker]:hidden">
                  {t(`${key}Q`)}
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-black/[0.04] text-gray-600 transition-transform duration-300 group-open:rotate-45 dark:bg-white/[0.06] dark:text-gray-300">
                    <Icon name="plus" className="h-4 w-4" />
                  </span>
                </summary>
                <p className="pb-5 pe-12 text-[15px] leading-relaxed text-gray-600 dark:text-gray-400">{t(`${key}A`)}</p>
              </details>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
