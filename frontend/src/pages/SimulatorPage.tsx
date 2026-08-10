import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { buildSnippet } from "../components/EmbedSnippet";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { useOrg } from "../lib/org";

/** What we could pull out of the pasted snippet. */
interface Parsed {
  src?: string;
  avatar?: string;
  key?: string;
  api?: string;
  size?: string;
  provider?: string;
  voice?: string;
  locale?: string;
}

/**
 * Read the attributes out of a pasted `<script>` tag.
 *
 * Parsed with DOMParser rather than a regex: the snippet is HTML, people
 * reformat it across lines, and single vs double quotes and attribute order
 * are all legal. A regex would reject perfectly valid paste-ins.
 */
function parseSnippet(text: string): Parsed | null {
  if (!text.trim()) return null;
  const doc = new DOMParser().parseFromString(`<body>${text}</body>`, "text/html");
  const tag = [...doc.querySelectorAll("script[src]")].find((s) =>
    (s.getAttribute("src") ?? "").includes("liveface")
  );
  if (!tag) return null;
  return {
    src: tag.getAttribute("src") ?? undefined,
    avatar: tag.getAttribute("data-avatar") ?? undefined,
    key: tag.getAttribute("data-key") ?? undefined,
    api: tag.getAttribute("data-api") ?? undefined,
    size: tag.getAttribute("data-size") ?? undefined,
    provider: tag.getAttribute("data-provider") ?? undefined,
    voice: tag.getAttribute("data-voice") ?? undefined,
    locale: tag.getAttribute("data-locale") ?? undefined,
  };
}

type Level = "info" | "ok" | "error";
interface Entry {
  at: number;
  level: Level;
  message: string;
}

/**
 * The page a customer would have.
 *
 * The snippet runs inside an iframe rather than on this page. That is not
 * caution for its own sake: the widget defines `window.Liveface` and mounts a
 * canvas, so running it here would collide with the dashboard and would also
 * not prove anything about a clean page. An iframe IS the customer's page —
 * same load order, same globals, same CORS — so if it works here it works
 * there.
 */
function buildDocument(p: Parsed): string {
  const attrs = [
    p.avatar && `data-avatar="${p.avatar}"`,
    p.key && `data-key="${p.key}"`,
    p.api && `data-api="${p.api}"`,
    p.size && `data-size="${p.size}"`,
    p.provider && `data-provider="${p.provider}"`,
    p.voice && `data-voice="${p.voice}"`,
    p.locale && `data-locale="${p.locale}"`,
  ]
    .filter(Boolean)
    .join("\n    ");

  return `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:transparent">
<script>
  const send = (level, message) => parent.postMessage({ lf: true, level, message }, "*");
  window.onerror = (m) => send("error", String(m));
  window.addEventListener("unhandledrejection", (e) => send("error", "unhandled: " + e.reason));
  // The widget reports its own failures through console.error; forward them
  // so a bad key or a missing avatar shows up in the log instead of only in
  // devtools, which is the whole point of running this here.
  const realError = console.error;
  console.error = (...a) => { send("error", a.map(String).join(" ")); realError(...a); };
</script>
<script src="${p.src}"
    ${attrs}
    onerror='parent.postMessage({lf:true,level:"error",message:"script failed to load: ${p.src}"},"*")'
></script>
<script>
  let tries = 0;
  const poll = setInterval(() => {
    if (window.Liveface) {
      clearInterval(poll);
      send("ok", "widget loaded — window.Liveface is available");
      const canvas = document.querySelector("canvas");
      send(canvas ? "ok" : "error",
        canvas ? "canvas mounted (" + canvas.width + "x" + canvas.height + ")"
               : "no canvas was mounted");
    } else if (++tries > 100) {
      clearInterval(poll);
      send("error", "timed out after 10s — window.Liveface never appeared");
    }
  }, 100);
  window.addEventListener("message", (e) => {
    if (e.data && e.data.speak && window.Liveface) {
      send("info", "speak(" + JSON.stringify(e.data.speak) + ")");
      Promise.resolve(window.Liveface.speak(e.data.speak))
        .then(() => send("ok", "finished speaking"))
        .catch((err) => send("error", "speak failed: " + err));
    }
    if (e.data && e.data.stop && window.Liveface) window.Liveface.stop();
  });
</script>
</body></html>`;
}

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

  /** Mint a fresh Simulator credential. Cheap, so it is done per run. */
  const mintToken = async (): Promise<string | null> => {
    if (!current) return null;
    try {
      const r = await api.post<{ token: string }>(
        `/orgs/${current.id}/api-keys/simulator-token`
      );
      return r.token;
    } catch (e) {
      setLog((prev) => [
        ...prev,
        { at: Date.now(), level: "error", message: `${t("simTokenFailed")} ${String(e)}` },
      ]);
      return null;
    }
  };

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
  // Speak dying for no visible reason, which reads as a broken product.
  useEffect(() => {
    if (mode !== "token" || !running) return;
    const stale = log.some(
      (l) => l.level === "error" && /simulator_token_invalid|401/i.test(l.message)
    );
    if (!stale) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, mode, running]);

  const ok = log.some((l) => l.level === "ok" && l.message.includes("canvas mounted"));
  const failed = log.some((l) => l.level === "error");

  return (
    <div>
      <h1 className="text-[32px] font-semibold tracking-[-0.03em] sm:text-[38px]">
        {t("simulator")}
      </h1>
      <p className="mt-1.5 max-w-2xl text-[15px] text-gray-500 dark:text-gray-400">
        {t("simSubtitle")}
      </p>

      <div className="mt-9 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        {/* ---- input ---- */}
        <div>
          <label htmlFor="snippet" className="mb-2 block text-[13px] font-medium">
            {t("simPasteLabel")}
          </label>
          <textarea
            id="snippet"
            value={snippet}
            onChange={(e) => setSnippet(e.target.value)}
            spellCheck={false}
            placeholder={`<script\n  src="https://avatar.mehdisadeghian.com/api/liveface.js"\n  data-avatar="…"\n  data-key="…"\n></script>`}
            className="h-44 w-full resize-y rounded-xl border border-black/[0.1] bg-white p-3.5 font-mono text-[12.5px] leading-relaxed
              text-gray-800 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20
              dark:border-white/[0.12] dark:bg-raised dark:text-gray-200"
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

          <div className="mt-4 flex overflow-hidden rounded-lg border border-black/10 dark:border-white/15">
            {(["token", "own"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 px-3 py-2 text-[12.5px] font-medium transition-colors ${
                  mode === m
                    ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                    : "text-gray-500 hover:bg-black/5 dark:hover:bg-white/10"
                }`}
              >
                {t(m === "token" ? "simModeToken" : "simModeOwn")}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[12.5px] text-gray-500 dark:text-gray-400">
            {t(mode === "token" ? "simModeTokenHint" : "simModeOwnHint")}
          </p>

          {placeholderKey && (
            <p className="mt-2 text-[12.5px] text-amber-600 dark:text-amber-400">
              {t("simPlaceholderKey")}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void run()}
              disabled={!parsed || missing.length > 0 || placeholderKey}
              className="inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-4 py-2 text-[13px] font-medium text-white
                transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-gray-900"
            >
              <Icon name="arrow" className="h-4 w-4" strokeWidth={2} />
              {running ? t("simRerun") : t("simRun")}
            </button>
            {running && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium ${
                  failed
                    ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400"
                    : ok
                      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
                      : "bg-black/[0.05] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400"
                }`}
              >
                {failed ? t("simFailed") : ok ? t("simWorking") : t("simChecking")}
              </span>
            )}
          </div>

          {running && (
            <div className="mt-5">
              <div className="flex gap-2">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && speak()}
                  placeholder={t("speakPlaceholder")}
                  className="input py-2 text-[13.5px]"
                />
                <button onClick={speak} className="btn-primary shrink-0 px-4 py-2 text-[13px]">
                  {t("speak")}
                </button>
                <button
                  onClick={() => frame.current?.contentWindow?.postMessage({ stop: true }, "*")}
                  className="btn-secondary shrink-0 px-3 py-2 text-[13px]"
                >
                  {t("stop")}
                </button>
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
                    e.level === "error"
                      ? "text-red-400"
                      : e.level === "ok"
                        ? "text-emerald-400"
                        : "text-gray-400"
                  }
                >
                  <span className="text-gray-600">
                    {new Date(e.at).toLocaleTimeString()}{" "}
                  </span>
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
                className="h-[420px] w-full bg-white dark:bg-[#101010]"
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
