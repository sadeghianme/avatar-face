import { ReactNode, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useLocation } from "react-router-dom";

import { Icon, type IconName } from "@/components/ui/Icon";
import { LanguageMenu } from "@/components/layout/LanguageMenu";
import { Spinner } from "@/components/ui/Spinner";
import { focusableIn, nextFocusIndex } from "@/lib/focus";
import { useAuth } from "@/providers/auth";
import { useOrg } from "@/providers/org";
import { useTheme } from "@/providers/theme";
import { OrgSwitcher } from "@/components/layout/OrgSwitcher";

/**
 * One list, no section headers.
 *
 * Four destinations do not need to be sorted into three labelled groups —
 * the labels took more vertical space than the links they organised, which is
 * exactly the kind of structure that makes a small app feel like paperwork.
 */
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
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const crumb = useCrumb();
  const { pathname } = useLocation();
  // The creation wizard uses the whole content area beside the rail, with
  // its own sticky progress and fixed action bar (features/avatars wizard).
  const wide = pathname.startsWith("/avatars/new");
  const drawer = useDrawer(open, setOpen, pathname);
  const { current, loading, setupFailed, retrySetup } = useOrg();
  const initial = (user?.display_name || user?.username || "?").charAt(0).toUpperCase();

  const sidebar = (
    <div className="flex min-h-full flex-col pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
      <Link
        to="/"
        className="flex items-center gap-2.5 px-5 pb-6 pt-5 text-[15px] font-semibold tracking-[-0.01em]"
      >
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

      <button
        onClick={logout}
        className="mx-3 mb-3 flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-500 text-[13px] font-medium text-white">
          {initial}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">
            {user?.display_name || user?.username}
          </span>
          <span className="block truncate text-[11.5px] text-gray-400">{t("logout")}</span>
        </span>
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-white text-gray-900 antialiased dark:bg-ink dark:text-gray-100">
      {/* Fixed rail on desktop; a drawer below lg so the content gets the
          whole width on a phone rather than a squeezed column. */}
      <aside className="fixed inset-y-0 start-0 z-40 hidden w-[232px] overflow-y-auto overscroll-contain border-e border-black/[0.07] lg:block dark:border-white/[0.07]">
        {sidebar}
      </aside>

      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t("closeMenu")}
            className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            onClick={() => setOpen(false)}
          />
          {/* A modal drawer: focus moves in and stays in (Tab wraps); Esc,
              the backdrop and any navigation close it; focus goes back to
              the menu button. Fixed, so the body's side inset does not
              reach it: its own. It scrolls when a phone on its side is
              shorter than the list. */}
          <aside
            id="app-drawer"
            ref={drawer.ref}
            role="dialog"
            aria-modal="true"
            aria-label={t("navGroupMenu")}
            onKeyDown={drawer.onKeyDown}
            className="fixed inset-y-0 start-0 z-50 box-content w-[232px] overflow-y-auto overscroll-contain bg-white ps-[env(safe-area-inset-left)] lg:hidden dark:bg-panel"
          >
            {sidebar}
          </aside>
        </>
      )}

      <div className="lg:ms-[232px]">
        {/* 3.5rem under the status bar: the wizard's progress sticks just below it. */}
        <header className="sticky top-0 z-30 h-[calc(3.5rem+env(safe-area-inset-top))] border-b pt-[env(safe-area-inset-top)] border-black/[0.07] bg-white/80 backdrop-blur-xl dark:border-white/[0.07] dark:bg-ink/80">
          <div
            className="flex h-full items-center gap-3 px-4"
          >
            <button
              ref={drawer.opener}
              type="button"
              aria-label={t("openMenu")}
              aria-controls="app-drawer"
              aria-expanded={open}
              className="-ms-1 grid place-items-center rounded-lg p-1.5 text-gray-500 hover:bg-black/5 coarse:-ms-2.5 coarse:h-11 coarse:w-11 lg:hidden dark:hover:bg-white/10"
              onClick={() => setOpen(true)}
            >
              <Icon name="menu" />
            </button>

            <h1 className="truncate text-[15px] font-medium tracking-[-0.01em]">{crumb}</h1>

            <div className="ms-auto flex items-center gap-1">
              <LanguageMenu />
              <button
                className="grid place-items-center rounded-lg p-2 text-gray-500 transition-colors hover:bg-black/5 hover:text-gray-900 coarse:h-11 coarse:w-11 dark:hover:bg-white/10 dark:hover:text-white"
                onClick={toggle}
                aria-label={t("theme")}
              >
                <Icon name={theme === "dark" ? "sun" : "moon"} className="h-[18px] w-[18px]" />
              </button>
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
              <button type="button" className="btn-primary min-h-11" onClick={retrySetup}>
                {t("retry")}
              </button>
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

/**
 * The phone and tablet drawer, as a modal: focus to the current page's link
 * on open, Tab and Shift+Tab wrap inside it (lib/focus), Esc closes it, any
 * change of route closes it, the page under it does not scroll, and focus
 * goes back to the menu button. Widening the window to the rail's
 * breakpoint closes it too, so the scroll lock never outlives it.
 */
function useDrawer(open: boolean, setOpen: (open: boolean) => void, pathname: string) {
  const ref = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  // Any navigation: a link in the drawer, or the browser's Back.
  useEffect(() => setOpen(false), [pathname, setOpen]);

  useEffect(() => {
    if (!open) return;
    const panel = ref.current;
    if (panel) {
      const items = focusableIn(panel);
      (items.find((el) => el.getAttribute("aria-current") === "page") ?? items[0])?.focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const wide = window.matchMedia("(min-width: 1024px)");
    const onWide = () => {
      if (wide.matches) setOpen(false);
    };
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    const button = opener.current;
    return () => {
      root.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected || panel?.contains(active)) {
        button?.focus({ preventScroll: true });
      }
    };
  }, [open, setOpen]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || !ref.current) return;
    const items = focusableIn(ref.current);
    const next = nextFocusIndex(items.indexOf(document.activeElement as HTMLElement), items.length, event.shiftKey);
    event.preventDefault();
    if (next >= 0) items[next].focus();
  }, []);

  return { ref, opener, onKeyDown };
}
