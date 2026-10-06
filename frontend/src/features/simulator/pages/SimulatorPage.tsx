import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Textarea } from "@/components/ui/Textarea";
import { buildSnippet } from "@/features/avatars";
import { useSimulatorToken } from "@/features/simulator/api";
import { buildDocument, type Entry, needsNewToken, type Parsed, parseSnippet } from "@/features/simulator/snippet";
import { cx } from "@/lib/cx";
import { useOrg } from "@/providers/org";

/** The pasted snippet: a code box of its own, not the form field look. */
const SNIPPET_BOX = cx(
  "h-44 resize-y rounded-xl border-black/[0.1] p-3.5 font-mono text-[12.5px] leading-relaxed text-gray-800",
  "focus:border-brand-400 focus:ring-brand-500/20 dark:border-white/[0.12] dark:text-gray-200"
);

/** The run's state, as a pill beside Run. */
const RUN_STATE = {
  failed: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400",
  ok: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400",
  checking: "bg-black/[0.05] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400",
};

/**
 * The page a customer would have: the pasted snippet runs in an iframe
 * (snippet.ts, buildDocument), with a short-lived key minted for this
 * page or the snippet's own, and a log of what the widget reports.
 */
export function SimulatorPage() {
  const { t } = useTranslation();
  // Arriving from an avatar's "Test in Simulator" prefills the snippet, so
  // the common path involves no copying at all.
  const [params] = useSearchParams();
  const [snippet, setSnippet] = useState(() => {
    const avatar = params.get("avatar");
    return avatar ? buildSnippet(avatar) : "";
  });
  const [running, setRunning] = useState<Parsed | null>(null);
  const [log, setLog] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  // "token" runs with a short-lived credential minted for this page; "own"
  // runs with whatever key is in the snippet. The difference is not cosmetic:
  // only the second one proves the customer's key is configured correctly.
  const [mode, setMode] = useState<"token" | "own">("token");
  const frame = useRef<HTMLIFrameElement>(null);
  const { current } = useOrg();
  const { mutateAsync: requestToken } = useSimulatorToken(current?.id);

  const parsed = useMemo(() => parseSnippet(snippet), [snippet]);
  // In token mode the key in the snippet is irrelevant — it is replaced at
  // run time — so it is not a missing field.
  const required = mode === "own" ? ["src", "avatar", "key"] : ["src", "avatar"];
  const missing = parsed ? required.filter((k) => !parsed[k as keyof Parsed]) : [];
  const placeholderKey = mode === "own" && parsed?.key === "YOUR_API_KEY";

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!e.data?.lf) return;
      setLog((prev) => [...prev.slice(-60), { at: Date.now(), level: e.data.level, message: e.data.message }]);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /** Mint a fresh Simulator credential (per run); a failure goes to the log. */
  const mintToken = useCallback(async (): Promise<string | null> => {
    if (!current) return null;
    try {
      return await requestToken();
    } catch (e) {
      setLog((prev) => [...prev, { at: Date.now(), level: "error", message: `${t("simTokenFailed")} ${String(e)}` }]);
      return null;
    }
  }, [current, requestToken, t]);

  const run = async () => {
    if (!parsed) return;
    setLog([{ at: Date.now(), level: "info", message: t("simStarting") }]);
    if (mode === "own") {
      setRunning({ ...parsed });
      return;
    }
    const token = await mintToken();
    if (!token) return;
    // The token goes into the running page, never into the textarea: a
    // 15-minute credential copied onto a live site works beautifully until it
    // silently stops.
    setRunning({ ...parsed, key: token });
  };

  const speak = () => {
    if (!text.trim()) return;
    frame.current?.contentWindow?.postMessage({ speak: text }, "*");
  };

  // Re-mint and re-run when the credential ages out mid-session. This is what
  // makes the short lifetime free: without it the expiry would surface as
  // Speak dying for no visible reason, which reads as a broken product. Only
  // a refusal since the last start or renewal counts (needsNewToken): the
  // old one stays in the log and used to renew again on every render.
  useEffect(() => {
    if (mode !== "token" || !running) return;
    if (!needsNewToken(log, [t("simStarting"), t("simRenewed")])) return;
    let cancelled = false;
    void (async () => {
      const token = await mintToken();
      if (cancelled || !token) return;
      setLog((prev) => [...prev, { at: Date.now(), level: "info", message: t("simRenewed") }]);
      setRunning((prev) => (prev ? { ...prev, key: token } : prev));
    })();
    return () => {
      cancelled = true;
    };
  }, [log, mode, running, mintToken, t]);

  const ok = log.some((l) => l.level === "ok" && l.message.includes("canvas mounted"));
  const failed = log.some((l) => l.level === "error");

  return (
    <div>
      <h1 className="text-[32px] font-semibold tracking-[-0.03em] sm:text-[38px]">{t("simulator")}</h1>
      <p className="mt-1.5 max-w-2xl text-[15px] text-gray-500 dark:text-gray-400">{t("simSubtitle")}</p>

      <div className="mt-9 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        {/* ---- input ---- */}
        <div>
          <label htmlFor="snippet" className="mb-2 block text-[13px] font-medium">
            {t("simPasteLabel")}
          </label>
          <Textarea
            id="snippet"
            value={snippet}
            onChange={(e) => setSnippet(e.target.value)}
            spellCheck={false}
            placeholder={`<script\n  src="https://avatar.mehdisadeghian.com/api/liveface.js"\n  data-avatar="…"\n  data-key="…"\n></script>`}
            className={SNIPPET_BOX}
          />

          {snippet.trim() && !parsed && (
            <p className="mt-2 text-[12.5px] text-red-600 dark:text-red-400">{t("simNoScript")}</p>
          )}

          {parsed && (
            <div className="mt-4 overflow-hidden rounded-xl border border-black/[0.08] dark:border-white/[0.1]">
              <table className="w-full text-[12.5px]">
                <tbody className="divide-y divide-black/[0.06] dark:divide-white/[0.08]">
                  {(["src", "avatar", "key", "api", "provider", "voice", "size"] as const).map(
                    (k) =>
                      parsed[k] && (
                        <tr key={k}>
                          <td className="w-28 bg-black/[0.02] px-3 py-2 font-medium text-gray-500 dark:bg-white/[0.03]">
                            {k}
                          </td>
                          <td className="truncate px-3 py-2 font-mono text-gray-700 dark:text-gray-300">
                            {/* The key is echoed back so a typo is visible, but
                                only its shape — enough to spot a wrong paste
                                without printing a live credential in full. */}
                            {k === "key" && parsed[k]!.length > 12
                              ? `${parsed[k]!.slice(0, 6)}…${parsed[k]!.slice(-4)}`
                              : parsed[k]}
                          </td>
                        </tr>
                      )
                  )}
                </tbody>
              </table>
            </div>
          )}

          {missing.length > 0 && (
            <p className="mt-2 text-[12.5px] text-amber-600 dark:text-amber-400">
              {t("simMissing", { fields: missing.join(", ") })}
            </p>
          )}

          <SegmentedControl
            className="mt-4"
            itemClassName="flex-1"
            label={t("simModeLabel")}
            options={[
              { value: "token", label: t("simModeToken") },
              { value: "own", label: t("simModeOwn") },
            ]}
            value={mode}
            onChange={setMode}
          />
          <p className="mt-2 text-[12.5px] text-gray-500 dark:text-gray-400">
            {t(mode === "token" ? "simModeTokenHint" : "simModeOwnHint")}
          </p>

          {placeholderKey && (
            <p className="mt-2 text-[12.5px] text-amber-600 dark:text-amber-400">{t("simPlaceholderKey")}</p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              variant="contrast"
              className="gap-1.5 rounded-full text-[13px]"
              icon={<Icon name="arrow" className="h-4 w-4" strokeWidth={2} />}
              onClick={() => void run()}
              disabled={!parsed || missing.length > 0 || placeholderKey}
            >
              {running ? t("simRerun") : t("simRun")}
            </Button>
            {running && (
              <span
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium",
                  RUN_STATE[failed ? "failed" : ok ? "ok" : "checking"]
                )}
              >
                {failed ? t("simFailed") : ok ? t("simWorking") : t("simChecking")}
              </span>
            )}
          </div>

          {running && (
            <div className="mt-5">
              <div className="flex gap-2">
                <Input
                  aria-label={t("speakPlaceholder")}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && speak()}
                  placeholder={t("speakPlaceholder")}
                  className="py-2 text-[13.5px]"
                />
                <Button onClick={speak} className="shrink-0 px-4 py-2 text-[13px]">
                  {t("speak")}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => frame.current?.contentWindow?.postMessage({ stop: true }, "*")}
                  className="shrink-0 px-3 py-2 text-[13px]"
                >
                  {t("stop")}
                </Button>
              </div>
            </div>
          )}

          {/* ---- log ---- */}
          {log.length > 0 && (
            <div className="mt-5 max-h-56 overflow-y-auto rounded-xl bg-gray-950 p-3 font-mono text-[11.5px] leading-relaxed">
              {log.map((e, i) => (
                <div
                  key={i}
                  className={
                    e.level === "error" ? "text-red-400" : e.level === "ok" ? "text-emerald-400" : "text-gray-400"
                  }
                >
                  <span className="text-gray-600">{new Date(e.at).toLocaleTimeString()} </span>
                  {e.message}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ---- the customer's page ---- */}
        <div>
          <p className="mb-2 text-[13px] font-medium">{t("simPreview")}</p>
          <div className="overflow-hidden rounded-2xl border border-black/[0.08] dark:border-white/[0.1]">
            <div className="flex items-center gap-1.5 border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.08]">
              <span className="h-2 w-2 rounded-full bg-red-400" />
              <span className="h-2 w-2 rounded-full bg-yellow-400" />
              <span className="h-2 w-2 rounded-full bg-green-400" />
              <span className="ms-2 text-[11px] text-gray-400">yoursite.com</span>
            </div>
            {running ? (
              <iframe
                ref={frame}
                title="simulator"
                // Scripts must run — that is the entire point. `allow-scripts`
                // without `allow-same-origin` would break the widget's fetches;
                // it loads from our own API, and the snippet is the user's own.
                sandbox="allow-scripts allow-same-origin"
                srcDoc={buildDocument(running)}
                className="h-[420px] w-full bg-white dark:bg-well"
              />
            ) : (
              <div className="grid h-[420px] place-items-center px-6 text-center text-[13px] text-gray-400">
                {t("simIdle")}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
