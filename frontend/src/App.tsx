import { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { useAuth } from "./lib/auth";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { ApiKeysPage } from "./pages/ApiKeysPage";
import { AvatarDetailPage } from "./pages/AvatarDetailPage";
import { AvatarsPage } from "./pages/AvatarsPage";
import { LoginPage } from "./pages/LoginPage";
import { MembersPage } from "./pages/MembersPage";
import { NewAvatarPage } from "./pages/NewAvatarPage";
import { RegisterPage } from "./pages/RegisterPage";
import { SettingsPage } from "./pages/SettingsPage";

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
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/invite/:token" element={<AcceptInvitePage />} />
      <Route path="/" element={<Protected><AvatarsPage /></Protected>} />
      <Route path="/avatars/new" element={<Protected><NewAvatarPage /></Protected>} />
      <Route path="/avatars/:avatarId" element={<Protected><AvatarDetailPage /></Protected>} />
      <Route path="/members" element={<Protected><MembersPage /></Protected>} />
      <Route path="/api-keys" element={<Protected><ApiKeysPage /></Protected>} />
      <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
