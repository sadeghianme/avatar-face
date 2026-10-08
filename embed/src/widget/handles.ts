/**
 * The page's widgets, as the page sees them: each widget's own handle, and
 * `window.Liveface` over all of them.
 *
 * Every `<script src=".../liveface.js">` runs its own copy of the bundle,
 * so what the widgets share is kept on the page: `window.Liveface`, made by
 * the first widget to come up or fail, with the list of the widgets that
 * are up under a global symbol (Symbol.for, the same in every copy).
 *
 *   Liveface.speak(text)        the FIRST widget to come up: on a page with
 *   Liveface.stop() …             one widget, that widget, as it always was
 *   Liveface.get("AVATAR_ID")   the widget showing that avatar (the first
 *                                 to come up, if several do), or null
 *   Liveface.get(element)       the widget drawn on that canvas, or booted
 *                                 by that script tag, or null
 *   Liveface.all()              every widget that is up, in the order they
 *                                 came up
 *
 * Each widget also hands its own handle to the page in its `liveface:ready`
 * event's `detail`: on its canvas (bubbling) and on its script tag (not
 * bubbling, so a listener on the document hears each widget once).
 *
 * `window.Liveface` is set when the first widget comes up or fails, not
 * before, as it always was. With no widget up (every one failed), its own
 * calls answer quietly: nothing to say, nothing speaking, no engine.
 */
import type { AvatarEngine } from "../engine";
import type { Avatar3DEngine } from "../engine3d";
import { listen, sttSupported, type ListenOptions } from "../stt";
import type { EngineTuning } from "../types";

/** One widget's API: what `window.Liveface` was, for one avatar. */
export interface LivefaceHandle {
  /** The avatar it shows: the snippet's data-avatar. */
  readonly avatar: string;
  /** The canvas it draws on, right after its script tag. */
  readonly canvas: HTMLCanvasElement;
  /** Say `text`: chunked and prefetched for long text. */
  speak(text: string): Promise<void>;
  stop(): void;
  isSpeaking(): boolean;
  /** The browser's speech recognition; resolves with the transcript. */
  listen(options?: ListenOptions): Promise<string>;
  sttSupported(): boolean;
  /** Adjust the animation live, e.g. tune({ mouthOpen: 1.3 }). */
  tune(partial: Partial<EngineTuning>): void;
  /** The engine itself: a page may call any of its public members, so
   *  they keep their names in liveface.js (scripts/mangle-names.mjs). */
  readonly engine: AvatarEngine | Avatar3DEngine | null;
}

/** `window.Liveface`: the first widget's API, and the way to the others. */
export interface LivefacePage extends Omit<LivefaceHandle, "avatar" | "canvas"> {
  /** The widget showing avatar `target`, or drawn on canvas `target`, or
   *  booted by script tag `target`; null when none of the widgets that are
   *  up is. */
  get(target: string | Element | null | undefined): LivefaceHandle | null;
  /** Every widget that is up, in the order they came up. */
  all(): LivefaceHandle[];
}

/** A widget that is up, and the script tag that booted it. */
interface Entry {
  handle: LivefaceHandle;
  script: Element;
}

const WIDGETS = Symbol.for("liveface.widgets");

type Registered = LivefacePage & { [WIDGETS]?: Entry[] };

/** The page's `window.Liveface`, made (and set) if no widget has yet. */
export function livefacePage(win: { Liveface?: LivefacePage } = window): LivefacePage {
  const existing = win.Liveface as Registered | undefined;
  if (existing && Array.isArray(existing[WIDGETS])) return existing;
  const widgets: Entry[] = [];
  const first = (): LivefaceHandle | undefined => widgets[0]?.handle;
  const page: LivefacePage = {
    speak: (text) => first()?.speak(text) ?? Promise.resolve(),
    stop: () => first()?.stop(),
    isSpeaking: () => first()?.isSpeaking() ?? false,
    listen: (options) => listen(options),
    sttSupported,
    tune: (partial) => first()?.tune(partial),
    get engine() {
      return first()?.engine ?? null;
    },
    get: (target) => {
      if (!target) return null;
      const found =
        typeof target === "string"
          ? widgets.find((w) => w.handle.avatar === target)
          : widgets.find((w) => w.handle.canvas === target || w.script === target);
      return found?.handle ?? null;
    },
    all: () => widgets.map((w) => w.handle),
  };
  Object.defineProperty(page, WIDGETS, { value: widgets });
  win.Liveface = page;
  return page;
}

/** A widget is up: add its handle to the page's (making the page's
 *  `window.Liveface` if it is the first). */
export function addWidget(
  handle: LivefaceHandle,
  script: Element,
  win: { Liveface?: LivefacePage } = window
): LivefacePage {
  const page = livefacePage(win) as Registered;
  page[WIDGETS]!.push({ handle, script });
  return page;
}

/** Tell the page `type` happened to the widget booted by `script` on
 *  `canvas`: on the canvas, bubbling, and on the script tag, not. */
export function announce(
  canvas: Pick<Element, "dispatchEvent">,
  script: Pick<Element, "dispatchEvent">,
  type: "liveface:ready" | "liveface:error",
  detail: unknown
): void {
  canvas.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  script.dispatchEvent(new CustomEvent(type, { bubbles: false, detail }));
}
