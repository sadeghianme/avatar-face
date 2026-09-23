import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { DEMO_PORTRAIT } from "@/components/brand/DemoAvatar";
import { Icon } from "@/components/ui/Icon";
import { useAuth } from "@/providers/auth";

import { Reveal } from "./Reveal";

export function FinalCta() {
  const { t } = useTranslation();
  const { user } = useAuth();
  return (
    <section className="px-5 pb-24 sm:px-6 sm:pb-32">
      <Reveal className="mx-auto max-w-7xl">
        <div className="relative isolate overflow-hidden rounded-[2rem] bg-gradient-to-br from-brand-500 via-brand-600 to-brand-700 px-7 py-16 text-center text-white sm:px-16 sm:py-20">
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 bg-[linear-gradient(to_right,rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.08)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_60%_70%_at_50%_40%,black,transparent)]"
          />
          <div className="relative mx-auto h-20 w-20">
            <span className="absolute inset-0 rounded-full bg-white/30 motion-safe:animate-ping" style={{ animationDuration: "2.4s" }} />
            <img src={DEMO_PORTRAIT} alt="" loading="lazy" decoding="async" className="relative h-20 w-20 rounded-full object-cover ring-4 ring-white/40" />
          </div>
          <h2 className="mx-auto mt-8 max-w-2xl text-balance text-[34px] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[48px]">
            {t("ctaTitle")}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[17px] leading-relaxed text-white/85">{t("ctaBody")}</p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <Link
              to={user ? "/app" : "/register"}
              className="btn group rounded-full bg-white px-6 py-3.5 text-[15px] font-semibold text-brand-700 shadow-lg hover:bg-brand-50"
            >
              {user ? t("openDashboard") : t("heroCtaPrimary")}
              <Icon name="arrow" className="h-4 w-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180" />
            </Link>
            {!user && (
              <Link to="/login" className="btn rounded-full px-6 py-3.5 text-[15px] font-semibold text-white ring-1 ring-white/40 hover:bg-white/10">
                {t("login")}
              </Link>
            )}
          </div>
        </div>
      </Reveal>
    </section>
  );
}
