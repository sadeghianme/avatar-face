/**
 * The Simulator's rules, apart from its page: reading a pasted snippet,
 * the customer's page it runs in, and when its short-lived key needs
 * renewing. parseSnippet needs a browser (DOMParser); the rest is plain,
 * and `npm test` checks it.
 */

/** What we could pull out of the pasted snippet. */
export interface Parsed {
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
export function parseSnippet(text: string): Parsed | null {
  if (!text.trim()) return null;
  const doc = new DOMParser().parseFromString(`<body>${text}</body>`, "text/html");
  const tag = [...doc.querySelectorAll("script[src]")].find((s) => (s.getAttribute("src") ?? "").includes("liveface"));
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

export type Level = "info" | "ok" | "error";
export interface Entry {
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
export function buildDocument(p: Parsed): string {
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

/** The key's refusal, as the widget reports it in the log. */
const KEY_REFUSED = /simulator_token_invalid|401/i;

/**
 * Whether the running page needs a fresh key: the widget refused the key
 * SINCE it was last given one (`fresh`: the log lines that mark a start or
 * a renewal). Earlier refusals stay in the log, and counting them again
 * after a renewal would renew forever.
 */
export function needsNewToken(log: readonly Entry[], fresh: readonly string[]): boolean {
  let since = 0;
  log.forEach((entry, i) => {
    if (entry.level === "info" && fresh.includes(entry.message)) since = i + 1;
  });
  return log.slice(since).some((entry) => entry.level === "error" && KEY_REFUSED.test(entry.message));
}
