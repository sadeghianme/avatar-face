import { useState } from "react";
import { useTranslation } from "react-i18next";

/** Dev: the API runs on its own port. Prod: Caddy exposes it under /api. */
export function apiBaseUrl(): string {
  return window.location.origin.includes("localhost")
    ? "http://localhost:7002"
    : `${window.location.origin}/api`;
}

/** The voice the snippet should reproduce. Matches VoiceSelection. */
export interface SnippetVoice {
  provider?: string;
  voice?: string;
  locale?: string;
}

/**
 * Exported so the Simulator prefills exactly what the user is told to paste.
 * Two copies of this would drift, and the Simulator's whole claim is that it
 * runs the same thing your site will.
 *
 * The voice attributes matter more than they look: `data-locale` chooses the
 * language the lip-sync is generated for, so a snippet that omits it makes a
 * French avatar move its mouth to English phonemes no matter which voice was
 * picked here. Emitted only when set, so the snippet stays short when the
 * defaults are what you want.
 */
export function buildSnippet(
  avatarId: string,
  apiKey?: string,
  voice?: SnippetVoice
): string {
  const apiBase = apiBaseUrl();
  // The widget bundle is served BY the API, so it lives under the same
  // base as every other API route (in production that's <origin>/api).
  const lines = [
    `<script`,
    `  src="${apiBase}/liveface.js"`,
    `  data-avatar="${avatarId}"`,
    `  data-key="${apiKey ?? "YOUR_API_KEY"}"`,
    `  data-api="${apiBase}"`,
  ];
  if (voice?.provider) lines.push(`  data-provider="${voice.provider}"`);
  if (voice?.voice) lines.push(`  data-voice="${voice.voice}"`);
  if (voice?.locale) lines.push(`  data-locale="${voice.locale}"`);
  lines.push(`></script>`, `<script>/* then: Liveface.speak("Hello!") */</script>`);
  return lines.join("\n");
}

export function EmbedSnippet({
  avatarId,
  apiKey,
  voice,
}: {
  avatarId: string;
  apiKey?: string;
  voice?: SnippetVoice;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const snippet = buildSnippet(avatarId, apiKey, voice);

  return (
    <div className="card">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-medium">{t("embedSnippet")}</h3>
        <button
          className="btn-secondary px-3 py-1 text-xs"
          onClick={() => {
            void navigator.clipboard.writeText(snippet);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? t("copied") : t("copy")}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-gray-900 p-3 text-xs leading-relaxed text-emerald-300">
        {snippet}
      </pre>
    </div>
  );
}
