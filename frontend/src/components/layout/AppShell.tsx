import { ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useLocation } from "react-router-dom";

import { LanguageMenu } from "@/components/layout/LanguageMenu";
import { OrgSwitcher } from "@/components/layout/OrgSwitcher";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Icon, type IconName } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { Spinner } from "@/components/ui/Spinner";
import { cx } from "@/lib/cx";
import { useAuth } from "@/providers/auth";
import { useOrg } from "@/providers/org";

/**
 * One list, no section headers.
 *
 * Four destinations do not need to be sorted into three labelled groups —
 * the labels took more vertical space than the links they organised, which is
 * exactly the kind of structure that makes a small app feel like paperwork.
 */
/** The bar over every page: 3.5rem under the status bar, frosted. */
const TOP_BAR = cx(
  "sticky top-0 z-30 h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]",
  "border-b border-black/[0.07] bg-white/80 backdrop-blur-xl dark:border-white/[0.07] dark:bg-ink/80"
);

const NAV: { to: string; key: string; icon: IconName }[] = [
  { to: "/app", key: "avatars", icon: "faces" },
  { to: "/photoface-hd", key: "photofaceHD", icon: "cube" },
  { to: "/lip-sync-lab", key: "lipSyncLab", icon: "speaker" },
  { to: "/reference-avatar", key: "referenceLab", icon: "faces" },
  { to: "/voices", key: "voicesNav", icon: "mic" },
  { to: "/members", key: "members", icon: "users" },
  { to: "/api-keys", key: "apiKeys", icon: "key" },
  { to: "/simulator", key: "simulator", icon: "play" },
  { to: "/settings", key: "settings", icon: "settings" },
];

/** The current page's name, for the title and breadcrumb. */
function useCrumb(): string {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  if (pathname.startsWith("/photoface-hd")) return t("photofaceHD");
  if (pathname.startsWith("/lip-sync-lab")) return t("lipSyncLab");
  if (pathname.startsWith("/reference-avatar")) return t("referenceLab");
  if (pathname.startsWith("/voices")) return t("voicesNav");
  if (pathname.startsWith("/members")) return t("members");
  if (pathname.startsWith("/api-keys")) return t("apiKeys");
  if (pathname.startsWith("/settings")) return t("settings");
  if (pathname.startsWith("/simulator")) return t("simulator");
  if (pathname.startsWith("/avatars/new")) return t("newAvatar");
  if (pathname.startsWith("/avatars/")) return t("avatars");
  return t("avatars");
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const crumb = useCrumb();
  const { pathname } = useLocation();
  // The creation wizard uses the whole content area beside the rail, with
  // its own sticky progress and fixed action bar (features/avatars wizard).
  const wide = pathname.startsWith("/avatars/new");
  const menuButton = useRef<HTMLButtonElement>(null);
  // Any navigation closes the drawer: a link in it, or the browser's Back.
  useEffect(() => setOpen(false), [pathname]);
  const { current, loading, setupFailed, retrySetup } = useOrg();
  const initial = (user?.display_name || user?.username || "?").charAt(0).toUpperCase();

  const sidebar = (
    <div className="flex min-h-full flex-col pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
      <Link to="/" className="flex items-center gap-2.5 px-5 pb-6 pt-5 text-[15px] font-semibold tracking-[-0.01em]">
        <img src="/brand/liveface-mark-512.png" alt="" className="h-7 w-7 rounded-[9px]" />
        {t("appName")}
      </Link>

      <div className="px-3">
        <OrgSwitcher />
      </div>

      <nav className="mt-5 flex flex-1 flex-col gap-0.5 px-3">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/app"}
            onClick={() => setOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-[7px] text-[13.5px] transition-colors coarse:min-h-11 coarse:text-[15px] ${
                isActive
                  ? "bg-black/[0.06] font-medium text-gray-900 dark:bg-white/[0.08] dark:text-white"
                  : "text-gray-500 hover:bg-black/[0.03] hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.04] dark:hover:text-gray-100"
              }`
            }
          >
            <Icon name={item.icon} className="h-[18px] w-[18px]" />
            {t(item.key)}
          </NavLink>
        ))}
      </nav>

      {/* The account row: who is signed in, and signing out. A one-off
          composition (the kit's unstyled button), 44px+ tall as drawn. */}
      <Button
        variant="unstyled"
        onClick={logout}
        className="mx-3 mb-3 flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-500 text-[13px] font-medium text-white">
          {initial}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{user?.display_name || user?.username}</span>
          <span className="block truncate text-[11.5px] text-gray-400">{t("logout")}</span>
        </span>
      </Button>
    </div>
  );

  return (
    <div className="min-h-screen bg-white text-gray-900 antialiased dark:bg-ink dark:text-gray-100">
      {/* Fixed rail on desktop; a drawer below lg so the content gets the
          whole width on a phone rather than a squeezed column. */}
      <aside className="fixed inset-y-0 start-0 z-40 hidden w-[232px] overflow-y-auto overscroll-contain border-e border-black/[0.07] lg:block dark:border-white/[0.07]">
        {sidebar}
      </aside>

      {/* Below lg the same list is a modal drawer (Drawer: focus in and
          kept in, Esc and the backdrop close it, focus back to the menu
          button). Fixed, so the body's side inset does not reach it: its
          own. */}
      <Drawer
        id="app-drawer"
        open={open}
        onClose={() => setOpen(false)}
        label={t("navGroupMenu")}
        closeLabel={t("closeMenu")}
        opener={menuButton}
        className="w-[232px]"
      >
        {sidebar}
      </Drawer>

      <div className="lg:ms-[232px]">
        {/* 3.5rem under the status bar: the wizard's progress sticks just below it. */}
        <header className={TOP_BAR}>
          <div className="flex h-full items-center gap-3 px-4">
            <IconButton
              ref={menuButton}
              label={t("openMenu")}
              icon="menu"
              iconClassName="h-5 w-5"
              aria-controls="app-drawer"
              aria-expanded={open}
              className="-ms-1 p-1.5 coarse:-ms-2.5 lg:hidden"
              onClick={() => setOpen(true)}
            />

            <h1 className="truncate text-[15px] font-medium tracking-[-0.01em]">{crumb}</h1>

            <div className="ms-auto flex items-center gap-1">
              <LanguageMenu />
              <ThemeToggle />
            </div>
          </div>
        </header>

        {/* Every page spans the whole width with 16px around it; the wizard
            keeps its top clear for its own sticky progress bar. */}
        <main className={wide ? "px-4" : "p-4"}>
          {current ? (
            children
          ) : setupFailed ? (
            <div role="alert" className="space-y-3">
              <p className="text-sm text-gray-600 dark:text-gray-300">{t("workspaceFailed")}</p>
              <Button size="lg" onClick={retrySetup}>
                {t("retry")}
              </Button>
            </div>
          ) : (
            <p role="status" className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Spinner className="h-4 w-4" /> {loading ? t("workspaceSetup") : t("loading")}
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
