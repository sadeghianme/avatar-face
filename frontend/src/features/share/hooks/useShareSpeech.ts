import { type AvatarEngine, BrowserTTS } from "@liveface/embed";
import { type RefObject, useState } from "react";

import { phraseCues, type PublicAvatar, serverVoiceFor, speakPublic } from "@/features/share/api";
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
 * A cloned voice says only the lines rendered in it. A visitor's other
 * words are said in the server's voice for the avatar's language instead
 * (the owner's Voices page promises as much): one voice for everyone still,
 * and nothing for the visitor to be told.
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
      const voice = {
        provider: serverVoice?.provider ?? "kokoro",
        voice: serverVoice?.voice ?? "af_heart",
        locale: serverVoice?.locale ?? "en-US",
      };
      let served = await speakPublic(token, { text: spoken, ...voice });
      if ("refused" in served && served.refused === "cloned_line_missing") {
        served = await speakPublic(token, { text: spoken, ...(await serverVoiceFor(voice.locale)) });
      }
      if ("spoken" in served) {
        const audio = served.spoken;
        await new Promise<void>((resolve) => {
          engineRef.current!.playAudio(audio.audio_b64, audio.audio_mime, audio.cues, resolve);
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
