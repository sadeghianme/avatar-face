import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { GuestOnly, Protected } from "@/app/guards";
import { LandingPage } from "@/features/landing";

// The landing page is the front door and ships in the entry chunk; every
// other screen is fetched when it is first visited, so a first-time visitor
// never downloads the dashboard.
const LoginPage = lazy(() => import("@/features/auth").then((m) => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import("@/features/auth").then((m) => ({ default: m.RegisterPage })));
const ForgotPasswordPage = lazy(() => import("@/features/auth").then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import("@/features/auth").then((m) => ({ default: m.ResetPasswordPage })));
const AcceptInvitePage = lazy(() => import("@/features/auth").then((m) => ({ default: m.AcceptInvitePage })));
const SharePage = lazy(() => import("@/features/share").then((m) => ({ default: m.SharePage })));
const AvatarsPage = lazy(() => import("@/features/avatars").then((m) => ({ default: m.AvatarsPage })));
const NewAvatarPage = lazy(() => import("@/features/avatars").then((m) => ({ default: m.NewAvatarPage })));
const AvatarDetailPage = lazy(() => import("@/features/avatars").then((m) => ({ default: m.AvatarDetailPage })));
const PhotofaceHDPage = lazy(() => import("@/features/lab").then((m) => ({ default: m.PhotofaceHDPage })));
const LipSyncLabPage = lazy(() => import("@/features/lab").then((m) => ({ default: m.LipSyncLabPage })));
const VoicesPage = lazy(() => import("@/features/voices").then((m) => ({ default: m.VoicesPage })));
const MembersPage = lazy(() => import("@/features/members").then((m) => ({ default: m.MembersPage })));
const ApiKeysPage = lazy(() => import("@/features/api-keys").then((m) => ({ default: m.ApiKeysPage })));
const SettingsPage = lazy(() => import("@/features/settings").then((m) => ({ default: m.SettingsPage })));
const SimulatorPage = lazy(() => import("@/features/simulator").then((m) => ({ default: m.SimulatorPage })));

export default function App() {
  return (
    // Public pages load without chrome; the app's own boundary sits inside
    // the shell (see Protected) so the sidebar stays put between screens.
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
  );
}
