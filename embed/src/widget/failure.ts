/**
 * What a visitor sees when the avatar cannot be shown: the canvas stays
 * where it is (the host page's layout is left alone), marked
 * `data-liveface-state="error"`, with a short note right after it, as the
 * "AI avatar" label is placed (disclosure.ts). The host page hears it as a
 * `liveface:error` event on the canvas (bubbling, `detail.stage` and
 * `detail.message`), the console as a warning; nothing is thrown into the
 * page.
 */
import type { WidgetFailure } from "./load";

const WORDS: Record<string, string> = {
  en: "Avatar unavailable",
  fr: "Avatar indisponible",
};

/** The note's words in `locale`'s language, English otherwise. */
export function unavailableText(locale: string): string {
  return WORDS[locale.toLowerCase().split(/[-_]/)[0]] ?? WORDS.en;
}

/** Just what showFailure needs of the canvas, so it is tested without a DOM. */
interface FailureHost {
  setAttribute(name: string, value: string): void;
  insertAdjacentElement(where: "afterend", element: HTMLElement): unknown;
  dispatchEvent(event: Event): boolean;
}

/** Show `failure` under `canvas` and tell the page and the console. */
export function showFailure(
  canvas: FailureHost,
  failure: WidgetFailure,
  locale: string,
  doc: Pick<Document, "createElement"> = document
): HTMLElement {
  console.warn(`[liveface] the avatar cannot be shown: ${failure.message}`);
  canvas.setAttribute("data-liveface-state", "error");
  const note = doc.createElement("div");
  note.textContent = unavailableText(locale);
  note.setAttribute("role", "status");
  note.setAttribute("data-liveface-status", "error");
  Object.assign(note.style, {
    display: "block",
    width: "max-content",
    maxWidth: "100%",
    margin: "6px 0 0",
    color: "#6b7280",
    font: "400 12px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif",
  });
  canvas.insertAdjacentElement("afterend", note);
  canvas.dispatchEvent(
    new CustomEvent("liveface:error", { bubbles: true, detail: { stage: failure.stage, message: failure.message } })
  );
  return note;
}
