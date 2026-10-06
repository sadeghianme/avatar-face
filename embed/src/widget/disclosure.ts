/**
 * The "AI avatar" label under the widget.
 *
 * When an AI made or changed the face (a touch-up of its eyes and lips, a
 * regenerated or stylised picture, a face generated from words), the
 * published snapshot says so: `disclosure.ai_edited` is `{mode, model}`.
 * Visitors on the customer's site are the ones who meet this face, so the
 * widget tells them, as the share page does: default on, a small label
 * under the canvas. A site that discloses it some other way can turn it
 * off with `data-ai-label="off"` on the snippet.
 *
 * Rendered only when the answer carries the key. A snapshot published
 * before disclosures were recorded has no `disclosure` at all, and its
 * visitors see exactly what they saw before (principle 6 of
 * docs/avatar-lines.md: nothing changes until its owner publishes).
 */

export interface Disclosure {
  ai_edited?: { mode: string; model?: string | null } | null;
  line?: string | null;
}

export interface AiLabel {
  text: string;
  title: string;
}

const WORDS: Record<string, AiLabel> = {
  en: { text: "AI avatar", title: "This face was made or changed by AI" },
  fr: { text: "Avatar IA", title: "Ce visage a été créé ou modifié par une IA" },
};

/** The label to show, or null: no disclosure, no AI, or turned off. */
export function aiLabel(
  disclosure: Disclosure | null | undefined,
  locale: string,
  setting: string | undefined
): AiLabel | null {
  if (!disclosure?.ai_edited) return null;
  const off = (setting ?? "").trim().toLowerCase();
  if (off === "off" || off === "false" || off === "0") return null;
  const language = locale.toLowerCase().split(/[-_]/)[0];
  return WORDS[language] ?? WORDS.en;
}

/** Just what renderAiLabel needs of the DOM, so it is tested without one. */
interface LabelHost {
  insertAdjacentElement(where: "afterend", element: HTMLElement): unknown;
}

/**
 * The label as an element placed right after `canvas`: a sibling rather
 * than an overlay, so the host page's layout and the canvas it styles are
 * left as they were. Inline styles only (the widget brings no stylesheet),
 * a dark pill that reads on light and dark pages alike.
 */
export function renderAiLabel(
  canvas: LabelHost,
  label: AiLabel,
  doc: Pick<Document, "createElement"> = document
): HTMLElement {
  const element = doc.createElement("div");
  element.textContent = label.text;
  element.title = label.title;
  element.setAttribute("data-liveface-label", "ai");
  Object.assign(element.style, {
    display: "block",
    width: "max-content",
    maxWidth: "100%",
    margin: "6px 0 0",
    padding: "2px 8px",
    borderRadius: "999px",
    background: "rgba(17, 24, 39, 0.78)",
    color: "#ffffff",
    font: "500 11px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif",
    letterSpacing: "0.01em",
  });
  canvas.insertAdjacentElement("afterend", element);
  return element;
}
