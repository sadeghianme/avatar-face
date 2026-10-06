import { ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { SNIPPETS } from "@/features/landing/data";

import { Reveal, SectionHeader } from "./Reveal";

type Tab = keyof typeof SNIPPETS;
const TABS: { id: Tab; key: string }[] = [
  { id: "html", key: "devTabEmbed" },
  { id: "js", key: "devTabJs" },
  { id: "rest", key: "devTabRest" },
];

/**
 * Enough highlighting to read code at a glance: comments, strings, tags and
 * a handful of keywords. Builds React nodes — no HTML strings, nothing to
 * escape wrong.
 */
function highlight(code: string): ReactNode[] {
  const pattern = /(\/\/[^\n]*|#[^\n]*|"[^"\n]*"|'[^'\n]*'|<\/?[a-z]+|\b(?:await|const|curl)\b|\bLiveface\b)/g;
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of code.matchAll(pattern)) {
    const token = match[0];
    const at = match.index ?? 0;
    if (at > last) out.push(code.slice(last, at));
    const className =
      token.startsWith("//") || token.startsWith("#")
        ? "text-gray-500"
        : token.startsWith('"') || token.startsWith("'")
          ? "text-emerald-300"
          : token.startsWith("<")
            ? "text-brand-400"
            : token === "Liveface"
              ? "text-sky-300"
              : "text-violet-300";
    out.push(
      <span key={at} className={className}>
        {token}
      </span>
    );
    last = at + token.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function Developers() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("html");
  const [copied, setCopied] = useState(false);

  return (
    <section id="developers" className="scroll-mt-20 py-24 sm:py-32">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-14 px-5 sm:px-6 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <SectionHeader align="start" eyebrow={t("devEyebrow")} title={t("devTitle")} subtitle={t("devBody")} />
          <ul className="mt-9 space-y-4">
            {["devPoint1", "devPoint2", "devPoint3"].map((key, i) => (
              <Reveal as="li" key={key} delay={i * 70} className="flex gap-3.5">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400">
                  <Icon name="check" className="h-3.5 w-3.5" strokeWidth={2.4} />
                </span>
                <span className="text-[15px] leading-relaxed text-gray-700 dark:text-gray-300">{t(key)}</span>
              </Reveal>
            ))}
          </ul>
        </div>

        <Reveal delay={100}>
          <div className="overflow-hidden rounded-3xl border border-black/10 bg-[#0b0b0c] shadow-[0_40px_100px_-40px_rgba(0,0,0,0.6)] dark:border-white/10">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2.5">
              <div role="tablist" aria-label={t("devTabsLabel")} className="flex gap-1">
                {TABS.map((item) => (
                  <button
                    key={item.id}
                    role="tab"
                    type="button"
                    id={`dev-tab-${item.id}`}
                    aria-selected={tab === item.id}
                    aria-controls="dev-panel"
                    onClick={() => {
                      setTab(item.id);
                      setCopied(false);
                    }}
                    className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors coarse:min-h-11 ${
                      tab === item.id ? "bg-white/10 text-white" : "text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    {t(item.key)}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(SNIPPETS[tab]);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1600);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-gray-300 transition-colors coarse:min-h-11 hover:bg-white/10 hover:text-white"
              >
                <Icon name={copied ? "check" : "copyIcon"} className="h-3.5 w-3.5" />
                {copied ? t("copied") : t("copy")}
              </button>
            </div>
            <pre
              id="dev-panel"
              role="tabpanel"
              aria-labelledby={`dev-tab-${tab}`}
              tabIndex={0}
              dir="ltr"
              className="min-h-[260px] overflow-x-auto p-5 text-[12.5px] leading-[1.75] text-gray-200 focus-visible:outline-none"
            >
              <code>{highlight(SNIPPETS[tab])}</code>
            </pre>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
