/**
 * What jsdom does not do and the dashboard relies on, for the rendering
 * tests (vitest.config.ts runs this first). Each shim is the least that
 * lets a component behave as it does in a browser; none of them draws.
 *
 * - layout: jsdom lays nothing out, so `getClientRects()` is always empty
 *   and every element would read as invisible to `focusableIn` (lib/focus).
 *   Here a connected element is visible unless it, or an ancestor, is
 *   `hidden` or display:none.
 * - <dialog>: `showModal`, `close`, `open`, and Escape firing "cancel" on
 *   the top modal dialog (and closing it unless the handler prevents it),
 *   as the HTML spec says.
 * - matchMedia (nothing matches unless a test says so: `setMedia`),
 *   ResizeObserver, IntersectionObserver, object URLs, scrolling, canvas
 *   contexts, media playback, pointer capture: inert stand-ins.
 */

const media = new Map<string, boolean>();
const mediaLists = new Set<{ query: string; fire: () => void }>();

/** Make a media query match (or not) from now on, telling its listeners. */
export function setMedia(query: string, matches: boolean): void {
  media.set(query, matches);
  for (const list of mediaLists) if (list.query === query) list.fire();
}

export function resetMedia(): void {
  media.clear();
}

function hiddenByAncestor(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.hasAttribute("hidden")) return true;
    if (node instanceof HTMLElement && node.style.display === "none") return true;
  }
  return false;
}

export function installDomShims(): void {
  Element.prototype.getClientRects = function getClientRects(this: Element) {
    const rects: DOMRect[] = this.isConnected && !hiddenByAncestor(this) ? [new DOMRect(0, 0, 1, 1)] : [];
    return Object.assign(rects, { item: (i: number) => rects[i] ?? null }) as unknown as DOMRectList;
  };

  // --- <dialog> -------------------------------------------------------------------------
  const modals: HTMLDialogElement[] = [];
  Object.defineProperty(HTMLDialogElement.prototype, "open", {
    configurable: true,
    get(this: HTMLDialogElement) {
      return this.hasAttribute("open");
    },
    set(this: HTMLDialogElement, value: boolean) {
      if (value) this.setAttribute("open", "");
      else this.removeAttribute("open");
    },
  });
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
    modals.push(this);
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    const at = modals.indexOf(this);
    if (at >= 0) modals.splice(at, 1);
    this.dispatchEvent(new Event("close"));
  };
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const top = modals[modals.length - 1];
    if (!top || !top.isConnected) return;
    const cancel = new Event("cancel", { cancelable: true });
    if (top.dispatchEvent(cancel)) top.close();
  });

  // --- Media queries ---------------------------------------------------------------------
  window.matchMedia = (query: string) => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const list = {
      get matches() {
        return media.get(query) ?? false;
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.delete(fn),
      addListener: (fn: (event: MediaQueryListEvent) => void) => listeners.add(fn),
      removeListener: (fn: (event: MediaQueryListEvent) => void) => listeners.delete(fn),
      dispatchEvent: () => true,
    };
    mediaLists.add({
      query,
      fire: () => {
        for (const fn of listeners) fn({ matches: list.matches, media: query } as MediaQueryListEvent);
      },
    });
    return list as unknown as MediaQueryList;
  };

  // --- Observers ---------------------------------------------------------------------------
  class InertObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  window.ResizeObserver = InertObserver as unknown as typeof ResizeObserver;
  window.IntersectionObserver = InertObserver as unknown as typeof IntersectionObserver;

  // --- Everything else ------------------------------------------------------------------------
  let blobs = 0;
  URL.createObjectURL = () => `blob:test/${++blobs}`;
  URL.revokeObjectURL = () => undefined;
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.scrollTo = () => undefined;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => undefined;
}
