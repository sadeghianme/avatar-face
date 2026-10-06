/**
 * What the widget downloads, and how each download fails: as a
 * WidgetFailure that says which part of the avatar it was and why (an HTTP
 * status and the API's error code), never as a JSON parse error of an
 * error page or a promise nobody catches.
 */

/** The part of the avatar a download was for. */
export type WidgetStage = "avatar" | "rig" | "picture" | "model" | "engine";

/** The avatar cannot be shown: which part failed and why. */
export class WidgetFailure extends Error {
  readonly stage: WidgetStage;
  constructor(stage: WidgetStage, message: string) {
    super(message);
    this.name = "WidgetFailure";
    this.stage = stage;
  }
}

/** `error` as a WidgetFailure: itself if it is one, else one of `stage`. */
export function asFailure(error: unknown, stage: WidgetStage): WidgetFailure {
  if (error instanceof WidgetFailure) return error;
  return new WidgetFailure(stage, error instanceof Error ? error.message : String(error));
}

/**
 * GET `url` as JSON. A request that fails, an HTTP error (with the API's
 * `{code, detail}` when it sends one) and a body that is not JSON are each
 * a WidgetFailure of `stage`. A signed URL that expired answers 403, and
 * that is what the console should say, not "Unexpected token '<'".
 */
export async function fetchJson<T>(url: string, stage: WidgetStage, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new WidgetFailure(stage, `the ${stage} request failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { code?: unknown; detail?: unknown } | null;
    const why = [body?.code, body?.detail].filter((part) => typeof part === "string" && part).join(": ");
    throw new WidgetFailure(stage, `the ${stage} request answered ${response.status}${why ? ` (${why})` : ""}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new WidgetFailure(stage, `the ${stage} response is not JSON`);
  }
}

/** An image, CORS-enabled so the engine can read its pixels. */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new WidgetFailure("picture", "a picture of the avatar did not load"));
    img.src = url;
  });
}

/**
 * Load the bundle at `src` once per page, resolving when it has run and
 * `ready` (its global is set). Two widgets on a page share one script tag:
 * the second waits for the first's tag to load or fail, rather than going
 * on before the bundle has defined anything. The tag says how its load
 * ended (`data-liveface-loaded`), for a widget that finds it afterwards.
 */
export function loadScript(src: string, ready: () => boolean, stage: WidgetStage): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const settle = () => (ready() ? resolve() : reject(new WidgetFailure(stage, `${src} did not load`)));
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src.replace(/["\\]/g, "\\$&")}"]`);
    if (existing) {
      if (existing.dataset.livefaceLoaded) return settle();
      existing.addEventListener("load", settle, { once: true });
      existing.addEventListener("error", settle, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => {
      script.dataset.livefaceLoaded = "ok";
      settle();
    };
    script.onerror = () => {
      script.dataset.livefaceLoaded = "error";
      settle();
    };
    document.head.appendChild(script);
  });
}
