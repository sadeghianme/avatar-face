import { ReactNode, useState } from "react";

import { CopyButton } from "@/components/ui/CopyButton";
import { Icon } from "@/components/ui/Icon";
import { Tabs } from "@/components/ui/Tabs";
import { SNIPPETS } from "@/features/landing/data";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { cx } from "@/lib/cx";

import { Reveal, SectionHeader } from "./Reveal";

type Tab = keyof typeof SNIPPETS;
const TABS: { id: Tab; key: MessageKey }[] = [
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

/** The dark window the snippets sit in, whatever the page's theme. */
const CODE_WINDOW = cx(
  "overflow-hidden rounded-3xl border border-black/10 bg-code dark:border-white/10",
  "shadow-[0_40px_100px_-40px_rgba(0,0,0,0.6)]"
);

/** A ghost button drawn for that window: light words, a light hover. */
const COPY_ON_DARK = cx(
  "gap-1.5 px-2.5 py-1.5 text-[12px] leading-normal text-gray-300",
  "hover:bg-white/10 hover:text-white dark:hover:bg-white/10"
);

export function Developers() {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>("html");

  return (
    <section id="developers" className="scroll-mt-20 py-24 sm:py-32">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-14 px-5 sm:px-6 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <SectionHeader align="start" eyebrow={t("devEyebrow")} title={t("devTitle")} subtitle={t("devBody")} />
          <ul className="mt-9 space-y-4">
            {(["devPoint1", "devPoint2", "devPoint3"] as const).map((key, i) => (
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
          <div className={CODE_WINDOW}>
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2.5">
              <Tabs
                items={TABS.map((item) => ({ value: item.id, label: t(item.key) }))}
                value={tab}
                onChange={setTab}
                label={t("devTabsLabel")}
                idPrefix="dev-tab"
                panelId="dev-panel"
              />
              {/* Keyed by the tab: "Copied" belongs to the snippet it copied. */}
              <CopyButton
                key={tab}
                text={SNIPPETS[tab]}
                label={t("copy")}
                copiedLabel={t("copied")}
                icon="copyIcon"
                copiedIcon="check"
                iconClassName="h-3.5 w-3.5"
                variant="ghost"
                className={COPY_ON_DARK}
              />
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
