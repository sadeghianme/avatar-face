import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

export function SiteFooter() {
  const { t } = useTranslation();
  const columns = [
    {
      title: "footerProduct",
      links: [
        { href: "#features", key: "footerFeatures" },
        { href: "#how", key: "navHow" },
        { href: "#platform", key: "navPlatform" },
        { href: "#faq", key: "navFaq" },
      ],
    },
    {
      title: "footerDevelopers",
      links: [
        { href: "#developers", key: "devTabEmbed" },
        { href: "#developers", key: "devTabJs" },
        { href: "#developers", key: "devTabRest" },
      ],
    },
  ];
  return (
    <footer className="border-t border-black/[0.07] dark:border-white/[0.07]">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 px-5 py-14 sm:px-6 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="max-w-xs">
          <Link
            to="/"
            className="flex items-center gap-2.5 coarse:min-h-11 text-[17px] font-semibold tracking-[-0.02em]"
          >
            <img src="/brand/liveface-mark-512.png" alt="" width={32} height={32} className="h-8 w-8 rounded-[10px]" />
            {t("appName")}
          </Link>
          <p className="mt-4 text-[14px] leading-relaxed text-gray-500 dark:text-gray-400">{t("footerTagline")}</p>
        </div>
        {columns.map((column) => (
          <div key={column.title}>
            <p className="text-[13px] font-semibold text-gray-950 dark:text-white">{t(column.title)}</p>
            <ul className="mt-4 space-y-3 coarse:mt-1 coarse:space-y-0">
              {column.links.map((link, i) => (
                <li key={i}>
                  <a
                    href={link.href}
                    className="text-[14px] text-gray-500 transition-colors hover:text-gray-950 coarse:inline-block coarse:min-w-11 coarse:py-3 dark:text-gray-400 dark:hover:text-white"
                  >
                    {t(link.key)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div>
          <p className="text-[13px] font-semibold text-gray-950 dark:text-white">{t("footerAccount")}</p>
          <ul className="mt-4 space-y-3 coarse:mt-1 coarse:space-y-0">
            <li>
              <Link
                to="/login"
                className="text-[14px] text-gray-500 transition-colors hover:text-gray-950 coarse:inline-block coarse:min-w-11 coarse:py-3 dark:text-gray-400 dark:hover:text-white"
              >
                {t("login")}
              </Link>
            </li>
            <li>
              <Link
                to="/register"
                className="text-[14px] text-gray-500 transition-colors hover:text-gray-950 coarse:inline-block coarse:min-w-11 coarse:py-3 dark:text-gray-400 dark:hover:text-white"
              >
                {t("register")}
              </Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-black/[0.06] dark:border-white/[0.06]">
        <p className="mx-auto max-w-7xl px-5 py-6 text-[13px] text-gray-400 sm:px-6">
          © {new Date().getFullYear()} {t("appName")}. {t("footerRights")}
        </p>
      </div>
    </footer>
  );
}
