import { type AvatarEngine, BrowserTTS } from "@liveface/embed";
import { type RefObject, useState } from "react";

import { phraseCues, type PublicAvatar, speakPublic } from "@/features/share/api";
import { useT } from "@/i18n";

/**
 * The share page's one control: the line typed, and saying it.
 *
 * Speak with the server voice, falling back to the visitor's own. The
 * server voice is the point of a share link: it sounds identical for
 * everyone who opens it, where device voices differ by OS so the same link
 * would sound like a different character on every machine. Kokoro runs on
 * our own CPU, so this costs the owner no per-character fee — only their
 * monthly character allowance, and the speech cache means a phrase asked
 * twice is synthesized once.
 *
 * If the instance has no server voice, or the request is throttled, the
 * visitor's browser voice takes over rather than the page going silent.
 */
export function useShareSpeech(
  token: string | undefined,
  avatar: PublicAvatar | null,
  engineRef: RefObject<AvatarEngine | null>
) {
  const { t } = useT();
  const [text, setText] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const speak = async () => {
    const spoken = text.trim();
    if (!spoken || speaking || !engineRef.current) return;
    setSpeaking(true);
    setError(null);
    try {
      // The avatar's PUBLISHED voice, so what the owner chose (and
      // published) is what every visitor hears. Browser-voice choices
      // cannot be synthesised server-side, so they fall through to the
      // visitor's own speechSynthesis below.
      const chosen = avatar?.voice;
      const serverVoice = chosen && chosen.provider !== "browser" ? chosen : null;
      const served = await speakPublic(token, {
        text: spoken,
        provider: serverVoice?.provider ?? "kokoro",
        voice: serverVoice?.voice ?? "af_heart",
        locale: serverVoice?.locale ?? "en-US",
      });
      if (served) {
        await new Promise<void>((resolve) => {
          engineRef.current!.playAudio(served.audio_b64, served.audio_mime, served.cues, resolve);
        });
        return;
      }

      // No server voice on this instance, or throttled: speak locally rather
      // than leave the visitor looking at a silent face.
      if (!BrowserTTS.supported()) throw new Error(t("shareNoVoice"));
      const tts = new BrowserTTS(engineRef.current, phraseCues);
      await tts.speak(spoken, undefined, "en-US");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setSpeaking(false);
    }
  };

  return { text, setText, speaking, error, speak: () => void speak() };
}

export type ShareSpeech = ReturnType<typeof useShareSpeech>;
