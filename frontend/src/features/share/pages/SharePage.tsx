import { useRef } from "react";
import { useParams } from "react-router-dom";

import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { ShareComposer } from "@/features/share/components/ShareComposer";
import { useShareEngine } from "@/features/share/hooks/useShareEngine";
import { useShareSpeech } from "@/features/share/hooks/useShareSpeech";
import { useT } from "@/i18n";

/**
 * The page behind a share link: one avatar, full screen, and a box to type in.
 *
 * Deliberately not the dashboard with the chrome hidden. A visitor arrives
 * with no account and one question — what does this thing do — so the whole
 * page is the answer: the face fills the screen and the only control is a
 * line to type and a button to press.
 *
 * Speech goes through the public endpoint, which is rate-limited and charges
 * the owner. Nothing here can address anything but this one avatar. The
 * engine is useShareEngine's, the line and its speech useShareSpeech's.
 */
export function SharePage() {
  const { t } = useT();
  const { token } = useParams<{ token: string }>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { avatar, failed, engineRef, dpr } = useShareEngine(token, canvasRef);
  const speech = useShareSpeech(token, avatar, engineRef);

  if (failed) {
    return (
      <div data-page-bg="night" className="flex min-h-screen items-center justify-center bg-gray-950 px-6 text-center">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">{t("shareGoneTitle")}</h1>
          <p className="mt-2 text-sm text-gray-400">{t("shareGoneBody")}</p>
        </div>
      </div>
    );
  }

  return (
    /* Fixed viewport height, not min-height: with min-h-screen the column can
       grow past the viewport, `flex-1` never bounds the middle row, and the
       canvas pushes the composer off the bottom of the screen. dvh so mobile
       browser chrome does not hide the input. */
    <div
      data-page-bg="night"
      className="flex h-[100dvh] flex-col overflow-hidden bg-gray-950 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
    >
      {/* A phone on its side (under 520px tall): the name and the composer
          take less height, so the face keeps most of the window. */}
      <header className="flex flex-wrap items-center gap-2 px-5 py-4 [@media(max-height:520px)]:py-2">
        <h1 className="text-sm font-medium text-gray-300">{avatar?.name ?? ""}</h1>
        {/* A visitor is told when an AI made or changed this face. */}
        {avatar?.disclosure?.ai_edited && (
          <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-gray-200">
            <Icon name="sparkles" className="h-3 w-3" />
            {t("shareAiAvatar")}
          </span>
        )}
      </header>

      {/* The face takes whatever room is left over: min-h-0 lets this flex
          child actually shrink, without which the canvas pushes the composer
          off the bottom of a short window. */}
      <main className="flex min-h-0 flex-1 items-center justify-center px-4">
        {!avatar && <Spinner className="h-8 w-8 text-gray-600" />}
        <canvas
          ref={canvasRef}
          width={Math.round(720 * dpr)}
          height={Math.round(720 * dpr)}
          style={{ display: avatar ? "block" : "none" }}
          // object-contain letterboxes the square backing store into whatever
          // shape the leftover space happens to be.
          className="h-full w-full rounded-2xl object-contain"
        />
      </main>

      <ShareComposer speech={speech} ready={Boolean(avatar)} />
    </div>
  );
}
