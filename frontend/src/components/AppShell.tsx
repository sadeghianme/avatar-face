import { ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useLocation } from "react-router-dom";

import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { OrgSwitcher } from "./OrgSwitcher";

/** Grouped like an admin console: a flat list stops scanning once it grows. */
const NAV_GROUPS = [
  { label: "navGroupMenu", items: [{ to: "/app", key: "avatars", icon: "🎭" }] },
  {
    label: "navGroupTeam",
    items: [
      { to: "/members", key: "members", icon: "👥" },
      { to: "/api-keys", key: "apiKeys", icon: "🔑" },
    ],
  },
  { label: "navGroupAccount", items: [{ to: "/settings", key: "settings", icon: "⚙️" }] },
] as const;

/** The current page's name, for the title and breadcrumb. */
function useCrumb(): string {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  if (pathname.startsWith("/members")) return t("members");
  if (pathname.startsWith("/api-keys")) return t("apiKeys");
  if (pathname.startsWith("/settings")) return t("settings");
  if (pathname.startsWith("/avatars/new")) return t("newAvatar");
  if (pathname.startsWith("/avatars/")) return t("avatars");
  return t("dashboard");
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const crumb = useCrumb();
  const initial = (user?.display_name || user?.username || "?").charAt(0).toUpperCase();

  const sidebar = (
    <div className="flex h-full flex-col">
      <Link
        to="/"
        className="flex items-center gap-2.5 px-5 py-[18px] text-lg font-bold tracking-tight text-gray-900 dark:text-white"
      >
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 text-white">
          ◕
        </span>
        {t("appName")}
      </Link>

      <div className="px-3 pb-3">
        <OrgSwitcher />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-3">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-5">
            <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400 dark:text-gray-500">
              {t(group.label)}
            </p>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/app"}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    `relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                      isActive
                        ? "bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200"
                        : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-200"
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span className="absolute inset-y-1.5 start-0 w-1 rounded-full bg-brand-600 dark:bg-brand-400" />
                      )}
                      <span aria-hidden>{item.icon}</span>
                      {t(item.key)}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-gray-200 p-3 dark:border-line">
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-sm font-semibold text-white">
            {initial}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user?.display_name || user?.username}</p>
            <p className="truncate text-xs text-gray-400">{user?.email}</p>
          </div>
        </div>
        <button onClick={logout} className="btn-secondary mt-2 w-full py-1.5 text-xs">
          {t("logout")}
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#faf9f7] text-gray-900 dark:bg-ink dark:text-gray-100">
      {/* Fixed rail on desktop; a drawer below lg so the content gets the
          whole width on a phone rather than a squeezed column. */}
      <aside className="fixed inset-y-0 start-0 z-40 hidden w-64 border-e border-gray-200 bg-white lg:block dark:border-line dark:bg-panel">
        {sidebar}
      </aside>

      {open && (
        <>
          <button
            aria-label="close menu"
            className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            onClick={() => setOpen(false)}
          />
          <aside className="fixed inset-y-0 start-0 z-50 w-64 border-e border-gray-200 bg-white lg:hidden dark:border-line dark:bg-panel">
            {sidebar}
          </aside>
        </>
      )}

      <div className="lg:ms-64">
        <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/85 backdrop-blur-xl dark:border-line dark:bg-panel/85">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
            <button
              aria-label="menu"
              className="btn-secondary px-2.5 py-1.5 lg:hidden"
              onClick={() => setOpen(true)}
            >
              ☰
            </button>

            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold leading-tight">{crumb}</h1>
              <p className="hidden text-xs text-gray-400 sm:block">
                {t("appName")} <span className="mx-1">/</span> {crumb}
              </p>
            </div>

            <div className="ms-auto flex items-center gap-2">
              <Link to="/avatars/new" className="btn-primary hidden px-3 py-1.5 text-xs sm:inline-flex">
                ＋ {t("newAvatar")}
              </Link>
              <button className="btn-secondary px-2.5 py-1.5" onClick={toggle} aria-label={t("theme")}>
                {theme === "dark" ? "☀️" : "🌙"}
              </button>
              <div className="relative">
                <button
                  className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-sm font-semibold text-white"
                  onClick={() => setMenu((m) => !m)}
                  aria-label={user?.username ?? "account"}
                >
                  {initial}
                </button>
                {menu && (
                  <>
                    <button
                      className="fixed inset-0 z-40 cursor-default"
                      aria-hidden="true"
                      tabIndex={-1}
                      onClick={() => setMenu(false)}
                    />
                    <div className="absolute end-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-line dark:bg-raised">
                      <div className="border-b border-gray-100 px-4 py-3 dark:border-line">
                        <p className="truncate text-sm font-medium">
                          {user?.display_name || user?.username}
                        </p>
                        <p className="truncate text-xs text-gray-400">{user?.email}</p>
                      </div>
                      <Link
                        to="/settings"
                        onClick={() => setMenu(false)}
                        className="block px-4 py-2.5 text-sm hover:bg-gray-50 dark:hover:bg-white/5"
                      >
                        ⚙️ {t("settings")}
                      </Link>
                      <Link
                        to="/"
                        onClick={() => setMenu(false)}
                        className="block px-4 py-2.5 text-sm hover:bg-gray-50 dark:hover:bg-white/5"
                      >
                        ← {t("backToSite")}
                      </Link>
                      <button
                        onClick={logout}
                        className="block w-full px-4 py-2.5 text-start text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
                      >
                        {t("logout")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </header>

        <main className="p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
