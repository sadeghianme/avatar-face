/**
 * Landing-page constants. Every number here is derived from the product, not
 * chosen for the page: the face outline is the demo portrait's own detected
 * landmarks, the openness curve is the first demo line's measured cue track,
 * and the language list is the backend's (app/services/tts/languages.py).
 */

/** Outline of the demo face (0-100 viewBox): oval, eyes, lips, brows, nose. */
export const FACE_PATHS = [
  "M49.6 21.9 L54.9 22.0 L59.4 22.7 L63.6 24.4 L66.4 26.9 L68.1 30.1 L69.1 33.6 L69.6 38.0 L69.5 42.2 L69.1 46.6 L68.3 51.3 L67.0 56.2 L65.3 60.3 L63.2 63.2 L60.6 65.9 L58.3 67.7 L56.0 69.2 L53.2 70.4 L49.8 70.7 L46.5 70.4 L43.9 69.3 L41.6 67.7 L39.5 65.9 L37.0 63.3 L35.1 60.3 L33.3 56.3 L32.0 51.3 L31.1 46.6 L30.6 42.3 L30.3 38.1 L30.6 33.7 L31.4 30.2 L33.1 27.0 L35.7 24.5 L39.7 22.9 L44.2 22.1 Z",
  "M37.2 37.4 L37.5 37.0 L38.0 36.6 L38.9 36.1 L40.4 35.8 L41.9 36.0 L43.5 36.7 L44.7 37.7 L45.3 38.3 L44.8 38.4 L43.8 38.4 L42.3 38.5 L40.9 38.6 L39.4 38.5 L38.5 38.2 L37.8 37.9 Z",
  "M62.5 37.4 L62.1 37.0 L61.6 36.6 L60.6 36.1 L59.2 35.8 L57.6 35.9 L56.0 36.7 L54.8 37.7 L54.3 38.3 L54.8 38.4 L55.8 38.4 L57.2 38.5 L58.7 38.6 L60.2 38.5 L61.1 38.3 L61.8 37.9 Z",
  "M42.0 57.0 L42.9 56.7 L44.0 56.4 L45.4 56.0 L47.6 55.6 L49.8 56.1 L52.0 55.6 L54.1 56.0 L55.6 56.4 L56.6 56.7 L57.5 56.9 L56.7 57.9 L55.5 58.9 L53.9 60.0 L51.9 60.8 L49.7 61.1 L47.5 60.9 L45.6 60.1 L44.0 59.0 L42.9 58.0 Z",
  "M33.5 33.3 L35.2 31.8 L37.9 30.9 L41.4 31.3 L45.5 32.0",
  "M53.7 31.9 L57.7 31.1 L61.4 30.7 L64.2 31.5 L66.0 33.1",
  "M49.7 36.9 L49.7 39.4 L49.6 41.6 L49.6 43.5 L49.6 45.7 L49.6 48.2",
];

/** Mouth openness across "Hi, I'm a live avatar, made from a single photo." */
export const OPENNESS = [
  0.29, 0.29, 0.29, 0.0, 0.0, 0.88, 0.88, 0.05, 0.05, 0.24, 0.0, 0.14, 0.4, 0.16, 0.0, 0.16, 0.84, 0.84, 0.84, 0.3, 0.0,
  0.0, 0.05, 0.43, 0.43, 0.28, 0.0, 0.18, 0.3, 0.68, 0.05, 0.0, 0.17, 0.28, 0.28, 0.44, 0.11, 0.18, 0.14, 0.18, 0.18,
  0.93, 0.2, 0.2, 0.0, 0.0, 0.0, 0.0,
];

/** Languages with built-in server voices, by native name. */
export const LANGUAGES = [
  "English",
  "Español",
  "Français",
  "Italiano",
  "Português",
  "Deutsch",
  "Nederlands",
  "Polski",
  "Русский",
  "Türkçe",
  "العربية",
  "فارسی",
  "हिन्दी",
];

export const API_ORIGIN = "https://avatar.mehdisadeghian.com/api";

export const SNIPPETS = {
  html: `<script
  src="${API_ORIGIN}/liveface.js"
  data-avatar="YOUR_AVATAR_ID"
  data-key="YOUR_API_KEY"
  data-api="${API_ORIGIN}"
></script>`,
  js: `// Say anything, in the avatar's published voice
await Liveface.speak("Welcome! How can I help today?");

// Hear a visitor's question (where the browser supports it)
const question = await Liveface.listen();

// Stop, check, fine-tune the animation live
Liveface.stop();
Liveface.isSpeaking();
Liveface.tune({ mouthOpen: 1.2 });`,
  rest: `curl -X POST ${API_ORIGIN}/embed/v1/synthesize \\
  -H "X-Api-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"text": "Hello!", "provider": "kokoro",
       "voice": "af_heart", "locale": "en-US"}'

# → { "audio_b64": "…", "audio_mime": "audio/mpeg",
#     "duration_ms": 1240, "cues": [{ "t": 0, "viseme": "sil" }, …] }`,
} as const;
