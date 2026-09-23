import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { Developers } from "@/features/landing/components/Developers";
import { Faq } from "@/features/landing/components/Faq";
import { Features } from "@/features/landing/components/Features";
import { FinalCta } from "@/features/landing/components/FinalCta";
import { Hero } from "@/features/landing/components/Hero";
import { HowItWorks } from "@/features/landing/components/HowItWorks";
import { Platform } from "@/features/landing/components/Platform";
import { ProofStrip } from "@/features/landing/components/ProofStrip";
import { SiteFooter } from "@/features/landing/components/SiteFooter";
import { SiteNav } from "@/features/landing/components/SiteNav";
import { Trust } from "@/features/landing/components/Trust";
import { UseCases } from "@/features/landing/components/UseCases";

export function LandingPage() {
  const { t } = useTranslation();
  useEffect(() => {
    document.title = t("landingDocTitle");
  }, [t]);

  return (
    <div className="min-h-screen bg-white text-gray-900 antialiased dark:bg-ink dark:text-gray-100">
      <a
        href="#main"
        className="sr-only z-[60] rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white focus:not-sr-only focus:fixed focus:start-4 focus:top-4"
      >
        {t("skipToContent")}
      </a>
      <SiteNav />
      <main id="main">
        <Hero />
        <ProofStrip />
        <HowItWorks />
        <Features />
        <Platform />
        <UseCases />
        <Developers />
        <Trust />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
