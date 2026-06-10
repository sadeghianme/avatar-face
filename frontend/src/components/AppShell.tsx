import { ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";

import { useAuth } from "../lib/auth";
import { OrgSwitcher } from "./OrgSwitcher";

const NAV = [
  { to: "/", key: "avatars", icon: "🎭" },
  { to: "/members", key: "members", icon: "👥" },
  { to: "/api-keys", key: "apiKeys", icon: "🔑" },
  { to: "/settings", key: "settings", icon: "⚙️" },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex flex-col gap-1 p-3">
      <OrgSwitcher />
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/"}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
              isActive
                ? "bg-brand-100 text-brand-700 dark:bg-brand-700/30 dark:text-brand-100"
                : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            }`
          }
        >
          <span aria-hidden>{item.icon}</span>
          {t(item.key)}
        </NavLink>
      ))}
      <div className="mt-auto border-t border-gray-200 pt-3 dark:border-gray-700">
        <div className="px-3 pb-2 text-xs text-gray-400">{user?.email}</div>
        <button onClick={logout} className="btn-secondary w-full">
          {t("logout")}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
      {/* Mobile top bar */}
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 md:hidden dark:border-gray-700 dark:bg-gray-800">
        <span className="text-lg font-bold text-brand-600">Liveface</span>
        <button
          aria-label="menu"
          className="btn-secondary px-3 py-1"
          onClick={() => setOpen((o) => !o)}
        >
          ☰
        </button>
      </header>
      {open && (
        <div className="border-b border-gray-200 bg-white md:hidden dark:border-gray-700 dark:bg-gray-800">
          {nav}
        </div>
      )}
      <div className="mx-auto flex max-w-7xl">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-e border-gray-200 bg-white md:flex dark:border-gray-700 dark:bg-gray-800">
          <div className="px-6 py-5 text-xl font-bold text-brand-600">Liveface</div>
          <div className="flex min-h-0 flex-1 flex-col">{nav}</div>
        </aside>
        <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
