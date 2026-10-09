import { describe, expect, it } from "vitest";

import {
  EXPRESSION_LEAD_MS,
  autoExpressions,
  expressionMarks,
  expressionMode,
  hasExpressionTags,
  parseExpressionTags,
  timeExpressionMarks,
} from "../expression-markup";

/** Expressions written into the text (expression-markup.ts): the tags out
 *  of what is said, where they stood, when they come on. */
describe("the expression tags", () => {
  it("are stripped, and each mark points at the word after it", () => {
    const raw =
      "Hello! [happy] I'm so glad you're here. [concerned] But I have to tell you something… [surprised] Really?!";
    const { text, marks } = parseExpressionTags(raw);
    expect(text).toBe("Hello! I'm so glad you're here. But I have to tell you something… Really?!");
    expect(marks.map((m) => [m.name, text.slice(m.char, m.char + 4)])).toEqual([
      ["happy", "I'm "],
      ["concerned", "But "],
      ["surprised", "Real"],
    ]);
    expect(marks.every((m) => m.intensity === 1)).toBe(true);
  });

  it("read an intensity as a fraction or a percentage, clamped", () => {
    const { marks } = parseExpressionTags("[happy:0.5] a [smile:60%] b [wow:.25] c [sad:3] d [neutral:0.7] e");
    expect(marks.map((m) => [m.name, m.intensity])).toEqual([
      ["happy", 0.5],
      ["happy", 0.6],
      ["surprised", 0.25],
      ["concerned", 1],
      ["neutral", 0],
    ]);
  });

  it("leave unknown brackets and escaped tags in the text", () => {
    const { text, marks } = parseExpressionTags("See note [1] and [sic], not \\[happy] but [HAPPY] yes.");
    expect(text).toBe("See note [1] and [sic], not [happy] but yes.");
    expect(marks).toEqual([{ char: text.indexOf("yes"), name: "happy", intensity: 1 }]);
    expect(hasExpressionTags("plain [1] text")).toBe(false);
    expect(hasExpressionTags("a [smile] b")).toBe(true);
  });

  it("leave no doubled or leading or trailing space, and clamp the places", () => {
    expect(parseExpressionTags("[happy] Hi there").text).toBe("Hi there");
    expect(parseExpressionTags("[happy]   [smile] Hi").marks.map((m) => m.char)).toEqual([0, 0]);
    expect(parseExpressionTags("Hi [happy] [sad] there").text).toBe("Hi there");
    const end = parseExpressionTags("Really?! [surprised]");
    expect(end.text).toBe("Really?!");
    expect(end.marks[0].char).toBe(end.text.length);
    expect(parseExpressionTags("glued[happy]word").text).toBe("gluedword");
    expect(parseExpressionTags("[happy]").text).toBe("");
  });
});

describe("the expression track's times", () => {
  const text = "Hello! I'm so glad you're here. Really?!";
  const words = [
    { char: 0, t: 0 },
    { char: 7, t: 500 },
    { char: 11, t: 780 },
    { char: 32, t: 1900 },
  ];

  it("start a lead ahead of their word, from the word marks", () => {
    const track = timeExpressionMarks(
      [
        { char: 7, name: "happy", intensity: 1 },
        { char: 32, name: "surprised", intensity: 0.8, holdMs: 400 },
      ],
      text,
      2400,
      words
    );
    expect(track).toEqual([
      { t: 500 - EXPRESSION_LEAD_MS, name: "happy", intensity: 1 },
      { t: 1900 - EXPRESSION_LEAD_MS, name: "surprised", intensity: 0.8, holdMs: 400 },
    ]);
  });

  it("never before 0; at the end past the last word or the text", () => {
    const track = timeExpressionMarks(
      [
        { char: 0, name: "happy", intensity: 1 },
        { char: 35, name: "concerned", intensity: 1 },
        { char: text.length, name: "neutral", intensity: 0 },
      ],
      text,
      2400,
      words
    );
    expect(track.map((c) => c.t)).toEqual([0, 2400, 2400]);
  });

  it("fall back to the place in the text without word marks", () => {
    const [cue] = timeExpressionMarks([{ char: 20, name: "happy", intensity: 1 }], text, 4000, null);
    expect(cue.t).toBe(Math.round((4000 * 20) / text.length - EXPRESSION_LEAD_MS));
    expect(timeExpressionMarks([], text, 4000, [])).toEqual([]);
  });
});

describe("the automatic mode", () => {
  it("smiles at a greeting, brightens an exclamation, and lifts the brows on a question", () => {
    const marks = autoExpressions("Hello there! It is raining. Do you have time?", "en-US");
    expect(marks.map((m) => [m.name, m.intensity])).toEqual([
      ["happy", 0.45],
      ["neutral", 0],
      ["surprised", 0.3],
    ]);
    expect(marks[2].holdMs).toBeGreaterThan(0);
    const text = "Hello there! It is raining. Do you have time?";
    expect(text.slice(marks[2].char)).toBe("time?");
  });

  it("reads a few English words, and only punctuation elsewhere", () => {
    expect(autoExpressions("I'm sorry to hear that.", "en")[0]).toMatchObject({ name: "concerned" });
    expect(autoExpressions("Hmm, let me check.", "en")[0]).toMatchObject({ name: "thinking" });
    expect(autoExpressions("That is wonderful.", "en")[0]).toMatchObject({ name: "happy", intensity: 0.5 });
    expect(autoExpressions("Wow.", "en")[0]).toMatchObject({ name: "surprised" });
    expect(autoExpressions("Hola, lo siento.", "es-ES")).toEqual([]);
    expect(autoExpressions("¡Qué bien!", "es-ES")[0]).toMatchObject({ name: "happy", intensity: 0.35 });
    expect(autoExpressions("", "en")).toEqual([]);
  });

  it("is silent on a text with tags of its own, and off is off", () => {
    expect(expressionMarks("Hello! [sad] Oh.", "auto", "en").marks.map((m) => m.name)).toEqual(["concerned"]);
    expect(expressionMarks("Hello! Oh.", "auto", "en").marks[0].name).toBe("happy");
    expect(expressionMarks("Hello! Oh.", "tags", "en").marks).toEqual([]);
    expect(expressionMarks("Hi [happy] you", "off")).toEqual({ text: "Hi you", marks: [] });
  });

  it("reads the widget's data-expressions", () => {
    expect(expressionMode("AUTO")).toBe("auto");
    expect(expressionMode(" off ")).toBe("off");
    expect(expressionMode(undefined)).toBe("tags");
    expect(expressionMode("yes")).toBe("tags");
  });
});
