import { useState } from "react";
import { useTranslation } from "react-i18next";

export function EmbedSnippet({ avatarId, apiKey }: { avatarId: string; apiKey?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  // Dev: the API runs on its own port. Prod: Caddy exposes it under /api.
  const apiBase = window.location.origin.includes("localhost")
    ? "http://localhost:7002"
    : `${window.location.origin}/api`;

  const snippet = [
    `<script`,
    `  src="${apiBase}/liveface.js"`,
    `  data-avatar="${avatarId}"`,
    `  data-key="${apiKey ?? "YOUR_API_KEY"}"`,
    `  data-api="${apiBase}"`,
    `></script>`,
    `<script>/* then: Liveface.speak("Hello!") */</script>`,
  ].join("\n");

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
