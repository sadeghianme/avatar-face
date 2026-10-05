import { Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { ErrorBoundary } from "@/app/ErrorBoundary";
import { GuestOnly, Protected } from "@/app/guards";
import { lazyPage } from "@/app/lazyPage";
import { ScrollToTop } from "@/app/ScrollToTop";
import { LandingPage } from "@/features/landing";

// The landing page is the front door and ships in the entry chunk; every
// other screen is fetched when it is first visited, so a first-time visitor
// never downloads the dashboard.
const LoginPage = lazyPage(() => import("@/features/auth").then((m) => m.LoginPage));
const RegisterPage = lazyPage(() => import("@/features/auth").then((m) => m.RegisterPage));
const ForgotPasswordPage = lazyPage(() => import("@/features/auth").then((m) => m.ForgotPasswordPage));
const ResetPasswordPage = lazyPage(() => import("@/features/auth").then((m) => m.ResetPasswordPage));
const AcceptInvitePage = lazyPage(() => import("@/features/auth").then((m) => m.AcceptInvitePage));
const SharePage = lazyPage(() => import("@/features/share").then((m) => m.SharePage));
const AvatarsPage = lazyPage(() => import("@/features/avatars").then((m) => m.AvatarsPage));
const NewAvatarPage = lazyPage(() => import("@/features/avatars").then((m) => m.NewAvatarPage));
const AvatarDetailPage = lazyPage(() => import("@/features/avatars").then((m) => m.AvatarDetailPage));
const PhotofaceHDPage = lazyPage(() => import("@/features/lab").then((m) => m.PhotofaceHDPage));
const LipSyncLabPage = lazyPage(() => import("@/features/lab").then((m) => m.LipSyncLabPage));
const VoicesPage = lazyPage(() => import("@/features/voices").then((m) => m.VoicesPage));
const MembersPage = lazyPage(() => import("@/features/members").then((m) => m.MembersPage));
const ApiKeysPage = lazyPage(() => import("@/features/api-keys").then((m) => m.ApiKeysPage));
const SettingsPage = lazyPage(() => import("@/features/settings").then((m) => m.SettingsPage));
const SimulatorPage = lazyPage(() => import("@/features/simulator").then((m) => m.SimulatorPage));

export default function App() {
  return (
    // Public pages load without chrome; the app's own boundary sits inside
    // the shell (see Protected) so the sidebar stays put between screens.
    // A screen that cannot load at all ends at the ErrorBoundary.
    <ErrorBoundary>
      {/* A new route starts at the top (an avatar opened from the bottom of
          the list used to open scrolled to its own bottom). */}
      <ScrollToTop />
      <Suspense fallback={<div className="min-h-screen bg-white dark:bg-ink" />}>
        <Routes>
          {/* Public. The landing page is the front door; it does not redirect a
              signed-in visitor away, it just offers them the dashboard instead. */}
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
          <Route path="/register" element={<GuestOnly><RegisterPage /></GuestOnly>} />
          <Route path="/forgot-password" element={<GuestOnly><ForgotPasswordPage /></GuestOnly>} />
          {/* Not GuestOnly: a stale session in another tab must not block a reset
              link, which is often opened exactly because the account is stuck. */}
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/invite/:token" element={<AcceptInvitePage />} />
          {/* Public: no auth, no shell — the whole page is the avatar. */}
          <Route path="/s/:token" element={<SharePage />} />

          {/* The app itself lives under /app. */}
          <Route path="/app" element={<Protected><AvatarsPage /></Protected>} />
          <Route path="/avatars/new" element={<Protected><NewAvatarPage /></Protected>} />
          {/* The wizard with a creation: the id is in the URL so a reload resumes it. */}
          <Route path="/avatars/new/:creationId" element={<Protected><NewAvatarPage /></Protected>} />
          <Route path="/avatars/:avatarId" element={<Protected><AvatarDetailPage /></Protected>} />
          <Route path="/photoface-hd" element={<Protected><PhotofaceHDPage /></Protected>} />
          <Route path="/lip-sync-lab" element={<Protected><LipSyncLabPage /></Protected>} />
          <Route path="/reference-avatar" element={<Protected><LipSyncLabPage reference /></Protected>} />
          <Route path="/voices" element={<Protected><VoicesPage /></Protected>} />
          <Route path="/members" element={<Protected><MembersPage /></Protected>} />
          <Route path="/api-keys" element={<Protected><ApiKeysPage /></Protected>} />
          <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
          <Route path="/simulator" element={<Protected><SimulatorPage /></Protected>} />
          {/* Anything unknown goes to the front door, not into the app. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
