import { describe, expect, it } from "vitest";

import { aiLabel, renderAiLabel } from "../disclosure";

/**
 * The widget's "AI avatar" label: shown when the published snapshot says an
 * AI made or changed the face, never for a snapshot from before
 * disclosures (no key at all), and off only when the site says so.
 */

const edited = { ai_edited: { mode: "touchup", model: "gemini-3.1-flash-image" }, line: "human" };

describe("aiLabel", () => {
  it("labels a face an AI made or changed", () => {
    expect(aiLabel(edited, "en-US", undefined)).toEqual({
      text: "AI avatar",
      title: "This face was made or changed by AI",
    });
    expect(aiLabel({ ai_edited: { mode: "generate", model: null } }, "en-GB", "")?.text).toBe("AI avatar");
  });

  it("says nothing for a photo as its owner gave it, or an old snapshot", () => {
    expect(aiLabel({ ai_edited: null, line: "human" }, "en-US", undefined)).toBeNull();
    expect(aiLabel(undefined, "en-US", undefined)).toBeNull();
    expect(aiLabel(null, "en-US", undefined)).toBeNull();
  });

  it("speaks the avatar's language, English otherwise", () => {
    expect(aiLabel(edited, "fr-FR", undefined)?.text).toBe("Avatar IA");
    expect(aiLabel(edited, "fr_CA", undefined)?.text).toBe("Avatar IA");
    expect(aiLabel(edited, "de-DE", undefined)?.text).toBe("AI avatar");
  });

  it("is on by default and off only when the snippet says so", () => {
    for (const off of ["off", "OFF", " false ", "0"]) expect(aiLabel(edited, "en-US", off)).toBeNull();
    for (const on of ["on", "true", "yes", ""]) expect(aiLabel(edited, "en-US", on)).not.toBeNull();
  });
});

describe("renderAiLabel", () => {
  it("puts the label right after the canvas, leaving the canvas alone", () => {
    const made: { textContent: string; title: string; attrs: Record<string, string>; style: Record<string, string> }[] = [];
    const doc = {
      createElement: () => {
        const element = {
          textContent: "",
          title: "",
          attrs: {} as Record<string, string>,
          style: {} as Record<string, string>,
          setAttribute(name: string, value: string) {
            element.attrs[name] = value;
          },
        };
        made.push(element);
        return element as unknown as HTMLElement;
      },
    } as unknown as Pick<Document, "createElement">;
    const placed: [string, unknown][] = [];
    const canvas = { insertAdjacentElement: (where: "afterend", el: HTMLElement) => placed.push([where, el]) };

    const element = renderAiLabel(canvas, { text: "AI avatar", title: "why" }, doc);
    expect(placed).toEqual([["afterend", element]]);
    expect(made[0].textContent).toBe("AI avatar");
    expect(made[0].title).toBe("why");
    expect(made[0].attrs["data-liveface-label"]).toBe("ai");
    expect(made[0].style.display).toBe("block");
  });
});
