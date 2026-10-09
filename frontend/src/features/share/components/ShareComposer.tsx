import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import type { ShareSpeech } from "@/features/share/hooks/useShareSpeech";
import { useT } from "@/i18n";
import { useMediaQuery } from "@/lib/useMediaQuery";

/**
 * The line to type and the button that says it, under the face. Enter
 * speaks, Shift+Enter is a newline; on a narrow phone the button is its
 * icon, so the box keeps the room for its words.
 */
export function ShareComposer({ speech, ready }: { speech: ShareSpeech; ready: boolean }) {
  const { t } = useT();
  // A narrow phone: the one-line box is ~270px, and the long hint would
  // wrap and be cut in half.
  const narrow = useMediaQuery("(max-width: 480px)");
  return (
    <footer className="px-4 pb-6 pt-3 [@media(max-height:520px)]:pb-2 [@media(max-height:520px)]:pt-2">
      <div className="mx-auto flex w-full max-w-2xl items-end gap-2">
        <Textarea
          value={speech.text}
          onChange={(e) => speech.setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter speaks, Shift+Enter is a newline — the convention every
            // message box already taught everyone.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              speech.speak();
            }
          }}
          rows={1}
          maxLength={600}
          placeholder={t(narrow ? "sharePlaceholderShort" : "sharePlaceholder")}
          className="min-h-[46px] resize-none bg-gray-900 text-gray-100 placeholder-gray-500"
        />
        {/* On a narrow phone the button is its icon (named for screen
            readers), so the box keeps the room for its words. */}
        <Button
          className="h-[46px] min-w-[46px] shrink-0 px-3 sm:px-5"
          icon="speaker"
          loading={speech.speaking}
          onClick={speech.speak}
          disabled={!speech.text.trim() || !ready}
          aria-label={t("sharePlay")}
        >
          <span className="max-[400px]:sr-only">{t("sharePlay")}</span>
        </Button>
      </div>
      {/* Announced as it appears; red on the night page, not the kit's
          FieldError colour, which is made for a white form. */}
      {speech.error && (
        <p role="alert" className="mx-auto mt-2 max-w-2xl text-xs text-red-400">
          {speech.error}
        </p>
      )}
      <p className="mx-auto mt-3 max-w-2xl text-center text-[11px] text-gray-500 [@media(max-height:520px)]:mt-1">
        {t("sharePoweredBy")}
      </p>
    </footer>
  );
}
