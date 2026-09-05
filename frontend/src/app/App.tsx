import { Navigate, Route, Routes } from "react-router-dom";

import { GuestOnly, Protected } from "@/app/guards";
import { ApiKeysPage } from "@/features/api-keys";
import { AcceptInvitePage, ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from "@/features/auth";
import { AvatarDetailPage, AvatarsPage, NewAvatarPage } from "@/features/avatars";
import { PhotofaceHDPage } from "@/features/lab";
import { LandingPage } from "@/features/landing";
import { MembersPage } from "@/features/members";
import { SettingsPage } from "@/features/settings";
import { SharePage } from "@/features/share";
import { SimulatorPage } from "@/features/simulator";
import { VoicesPage } from "@/features/voices";

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
      {/* Public: no auth, no shell — the whole page is the avatar. */}
      <Route path="/s/:token" element={<SharePage />} />

      {/* The app itself lives under /app. */}
      <Route path="/app" element={<Protected><AvatarsPage /></Protected>} />
      <Route path="/avatars/new" element={<Protected><NewAvatarPage /></Protected>} />
      <Route path="/avatars/:avatarId" element={<Protected><AvatarDetailPage /></Protected>} />
      <Route path="/photoface-hd" element={<Protected><PhotofaceHDPage /></Protected>} />
      <Route path="/voices" element={<Protected><VoicesPage /></Protected>} />
      <Route path="/members" element={<Protected><MembersPage /></Protected>} />
      <Route path="/api-keys" element={<Protected><ApiKeysPage /></Protected>} />
      <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/simulator" element={<Protected><SimulatorPage /></Protected>} />
      {/* Anything unknown goes to the front door, not into the app. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
