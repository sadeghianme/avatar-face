/**
 * The Simulator's rules, apart from its page: reading a pasted snippet,
 * which of its values may run, the customer's page it runs in, what that
 * page may tell the Simulator, and when its short-lived key needs renewing.
 * parseSnippet needs a browser (DOMParser); the rest is plain, and
 * `npm test` checks it.
 *
 * The snippet is untrusted input: it comes from a paste or from the
 * `?avatar=` of a link anyone can send. Three layers keep it from reaching
 * the signed-in dashboard (docs/process.md, "Security headers"):
 *  1. values are checked (an avatar id is an id) and every one is escaped
 *     into the page it runs in (buildDocument), so a value stays a value;
 *  2. that page runs in a frame without `allow-same-origin`
 *     (SimulatorPage), so it has an origin of its own and cannot read this
 *     dashboard's storage, cookies or DOM;
 *  3. the dashboard's CSP has no `'unsafe-inline'` for scripts, and the
 *     frame inherits it: the page carries no inline script, only
 *     /simulator-frame.js and the widget, so an injected one would not run.
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

/**
 * An avatar id as the API makes them: a UUID's 32 lowercase hex digits
 * (backend app/models/base.py, `uuid4().hex`). Nothing else may be run as
 * one: the id is the value a crafted `?avatar=` link carries.
 */
const AVATAR_ID = /^[0-9a-f]{32}$/;

export function isAvatarId(value: string | null | undefined): value is string {
  return typeof value === "string" && AVATAR_ID.test(value);
}

/**
 * The avatar a link asks the Simulator to prefill (`?avatar=<id>`), or null
 * when it carries anything but an id. No other parameter is read: a link
 * can choose which avatar, never what runs.
 */
export function avatarFromQuery(params: URLSearchParams): string | null {
  const avatar = params.get("avatar");
  return isAvatarId(avatar) ? avatar : null;
}

/** An absolute http(s) URL: what a script's src and the API base must be. */
function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The fields of `p` whose values cannot be run: an avatar that is not an
 * id, a src or an API base that is not an http(s) URL. Empty when every
 * value present is fine (a missing field is the page's `missing`).
 */
export function invalidFields(p: Parsed): (keyof Parsed)[] {
  const bad: (keyof Parsed)[] = [];
  if (p.src && !isWebUrl(p.src)) bad.push("src");
  if (p.avatar && !isAvatarId(p.avatar)) bad.push("avatar");
  if (p.api && !isWebUrl(p.api)) bad.push("api");
  return bad;
}

/**
 * `value` as a double-quoted HTML attribute's content: every character that
 * could end the attribute or the tag, or start an entity, is written as an
 * entity, so the value comes back from the parser exactly as it went in.
 */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The snippet's attributes, in the order a pasted snippet has them. */
const WIDGET_ATTRIBUTES = [
  ["src", "src"],
  ["avatar", "data-avatar"],
  ["key", "data-key"],
  ["api", "data-api"],
  ["size", "data-size"],
  ["provider", "data-provider"],
  ["voice", "data-voice"],
  ["locale", "data-locale"],
] as const satisfies readonly (readonly [keyof Parsed, string])[];

/**
 * The page a customer would have.
 *
 * The snippet runs inside an iframe rather than on this page. That is not
 * caution for its own sake: the widget defines `window.Liveface` and mounts a
 * canvas, so running it here would collide with the dashboard and would also
 * not prove anything about a clean page. An iframe IS the customer's page —
 * same load order, same globals, same CORS — so if it works here it works
 * there. And like a customer's page it is another origin (an opaque one:
 * the frame has no `allow-same-origin`), which is what keeps a hostile
 * snippet away from the dashboard's session.
 *
 * Nothing in it is inline script. `harness` (/simulator-frame.js, served by
 * the dashboard) comes first: it reports to the Simulator what the widget
 * does and passes Speak and Stop on. Then the widget's own tag, written
 * from the snippet's values, each one escaped. Refuses (throws) values
 * invalidFields rejects or a snippet without src and avatar: the page
 * never builds a document from them.
 */
export function buildDocument(p: Parsed, harness: string): string {
  const bad = invalidFields(p);
  if (!p.src || !p.avatar || bad.length > 0) {
    throw new Error(
      `the snippet cannot be run (${bad.length ? `invalid: ${bad.join(", ")}` : "src and avatar are required"})`
    );
  }
  const attributes = WIDGET_ATTRIBUTES.flatMap(([field, name]) => {
    const value = p[field];
    return value ? [`${name}="${escapeAttribute(value)}"`] : [];
  });

  return `<!doctype html>
<html><head><meta charset="utf-8">
<script src="${escapeAttribute(harness)}"></script>
</head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:transparent">
<script ${attributes.join("\n    ")}></script>
</body></html>`;
}

export type Level = "info" | "ok" | "error";
export interface Entry {
  at: number;
  level: Level;
  message: string;
}

/**
 * A log line the customer's page sent (simulator-frame.js), or null for
 * anything else. The page runs whatever was pasted, so what it says is
 * data: a known level and a string, kept short.
 */
export function frameMessage(data: unknown): Omit<Entry, "at"> | null {
  if (typeof data !== "object" || data === null) return null;
  const { lf, level, message } = data as Record<string, unknown>;
  if (lf !== true || (level !== "info" && level !== "ok" && level !== "error") || typeof message !== "string") {
    return null;
  }
  return { level, message: message.slice(0, 2000) };
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
