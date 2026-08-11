import { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { useAuth } from "./lib/auth";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { ApiKeysPage } from "./pages/ApiKeysPage";
import { AvatarDetailPage } from "./pages/AvatarDetailPage";
import { AvatarsPage } from "./pages/AvatarsPage";
import { LandingPage } from "./pages/LandingPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { LoginPage } from "./pages/LoginPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { MembersPage } from "./pages/MembersPage";
import { NewAvatarPage } from "./pages/NewAvatarPage";
import { RegisterPage } from "./pages/RegisterPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SimulatorPage } from "./pages/SimulatorPage";

/** Already signed in? An auth page has nothing to offer — go to the app. */
function GuestOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  return user ? <Navigate to="/app" replace /> : <>{children}</>;
}

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-gray-500">
        {t("loading")}
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <AppShell>{children}</AppShell>;
}

export default function App() {
  return (
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

      {/* The app itself lives under /app. */}
      <Route path="/app" element={<Protected><AvatarsPage /></Protected>} />
      <Route path="/avatars/new" element={<Protected><NewAvatarPage /></Protected>} />
      <Route path="/avatars/:avatarId" element={<Protected><AvatarDetailPage /></Protected>} />
      <Route path="/members" element={<Protected><MembersPage /></Protected>} />
      <Route path="/api-keys" element={<Protected><ApiKeysPage /></Protected>} />
      <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/simulator" element={<Protected><SimulatorPage /></Protected>} />
      {/* Anything unknown goes to the front door, not into the app. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
