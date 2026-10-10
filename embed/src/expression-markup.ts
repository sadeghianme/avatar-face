/**
 * Expressions written into the text an avatar speaks (docs/emotions.md):
 *
 *   Hello! [happy] I'm so glad you're here. [concerned:0.6] But…
 *
 * `parseExpressionTags` strips the tags (the voice never reads them, the
 * speech cache keys the spoken text) and says where each stood in the
 * stripped text; `timeExpressionMarks` turns those places into times on the
 * speech's clock from the words' start times; `autoExpressions` is the
 * optional automatic mode's guess for a text without tags.
 *
 * Shared by the widget's two voices (speech.ts for the server's, browser-
 * tts.ts for the browser's) and exported for any page that drives the
 * engine itself.
 */
import type { ExpressionCue } from "./engine/expression-mixer";
import { expressionNamed, type ExpressionName } from "./engine/expression-table";

/** An expression at a place in a text: from character `char` of the
 *  stripped text on, `name` at `intensity`, held `holdMs` (default: until
 *  the next). */
export interface ExpressionMark {
  char: number;
  name: ExpressionName;
  intensity: number;
  holdMs?: number;
}

/** A text with its tags taken out: what is spoken, and where each was. */
export interface ParsedText {
  text: string;
  marks: ExpressionMark[];
}

/** A word's start, ms, by its character in the text (the API's word_marks). */
export interface WordMark {
  char: number;
  t: number;
}

/** How far ahead of its word an expression starts: a face leads speech. */
export const EXPRESSION_LEAD_MS = 150;

/** `[name]`, `[name:0.6]` or `[name:60%]`, maybe escaped as `\[name]`. */
const TAG = /(\\?)\[([A-Za-z]+)(?:\s*:\s*(\d*\.?\d+)(%?))?\]/g;
/** What could be a tag, known name or not (speech.ts holds these out of
 *  its sentence split). */
export const TAG_PATTERN = new RegExp(TAG.source, "g");

/**
 * The text with its expression tags taken out, and where each stood.
 *
 * Only a known name or alias is a tag: any other bracket ("[1]", "[sic]")
 * stays in the text, and `\[happy]` is the literal "[happy]". The space a
 * tag leaves is collapsed, so "Hello! [happy] I'm" is spoken "Hello! I'm"
 * and the mark points at "I'm".
 */
export function parseExpressionTags(raw: string): ParsedText {
  let out = "";
  const marks: ExpressionMark[] = [];
  let last = 0;
  // Skip the whitespace after a tag when the text already ends in a space
  // (or nothing): a tag never leaves two spaces, or a leading one.
  let skipSpace = false;
  const append = (piece: string) => {
    const trimmed = skipSpace && (out === "" || /\s$/.test(out)) ? piece.replace(/^\s+/, "") : piece;
    if (trimmed) skipSpace = false;
    out += trimmed;
  };
  for (const m of raw.matchAll(TAG)) {
    const [whole, escape, word, amount, percent] = m;
    const at = m.index;
    append(raw.slice(last, at));
    last = at + whole.length;
    const name = expressionNamed(word);
    if (escape || !name) {
      append(escape ? whole.slice(1) : whole);
      continue;
    }
    let intensity = name === "neutral" ? 0 : 1;
    if (amount !== undefined && name !== "neutral") {
      const value = parseFloat(amount) / (percent ? 100 : 1);
      intensity = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
    }
    skipSpace = true;
    marks.push({ char: out.length, name, intensity });
  }
  append(raw.slice(last));
  const lead = out.length - out.trimStart().length;
  const text = out.trim();
  for (const mark of marks) mark.char = Math.max(0, Math.min(text.length, mark.char - lead));
  return { text, marks };
}

/** Whether `raw` holds any expression tag. */
export function hasExpressionTags(raw: string): boolean {
  return parseExpressionTags(raw).marks.length > 0;
}

/**
 * The marks as an expression track on the speech's clock (ms): each at its
 * word's start (`wordMarks`, the API's word_marks), EXPRESSION_LEAD_MS
 * ahead of it; without word marks, in proportion to its place in `text`
 * over `durationMs`. A mark past the last word is at the end.
 */
export function timeExpressionMarks(
  marks: readonly ExpressionMark[],
  text: string,
  durationMs: number,
  wordMarks?: readonly WordMark[] | null
): ExpressionCue[] {
  const words = wordMarks?.length ? [...wordMarks].sort((a, b) => a.char - b.char) : null;
  const atChar = (char: number): number => {
    if (char >= text.length) return durationMs;
    if (!words) return (durationMs * char) / Math.max(1, text.length);
    const word = words.find((w) => w.char >= char);
    return word ? word.t : durationMs;
  };
  return marks.map((m) => {
    const at = atChar(m.char);
    const t = at >= durationMs ? durationMs : Math.max(0, at - EXPRESSION_LEAD_MS);
    const cue: ExpressionCue = { t: Math.round(t), name: m.name, intensity: m.intensity };
    if (m.holdMs !== undefined) cue.holdMs = m.holdMs;
    return cue;
  });
}

// --- The automatic mode -------------------------------------------------------------

/** What the automatic mode reads: a greeting opening the text, a sentence's
 *  words (English), its punctuation (any language). */
const GREETING = /^\s*(hello|hi|hey|welcome|good (morning|afternoon|evening)|thanks|thank you|greetings)\b/i;
const LEXICON: readonly [RegExp, ExpressionName, number][] = [
  [/\b(sorry|unfortunately|sadly|bad news|i'?m afraid|regret)\b/i, "concerned", 0.5],
  [/\b(hmm+|let me think|i wonder|perhaps|maybe)\b/i, "thinking", 0.6],
  [/\b(wow|really|amazing|incredible|unbelievable|no way)\b/i, "surprised", 0.5],
  [/\b(great|wonderful|glad|love|excited|fantastic|awesome|delighted|happy)\b/i, "happy", 0.5],
];
/** The brows up over a question's last word, briefly. */
const QUESTION = { intensity: 0.3, holdMs: 500 } as const;
const EXCLAIM = 0.35;
const GREET = 0.45;

/**
 * The automatic mode's marks for a text without tags of its own: a greeting
 * smiles, an exclamation brightens, a question lifts the brows at its end,
 * and a few words set a sentence's expression (English only: `locale`).
 * Each sentence's expression is released where the next sentence starts.
 */
export function autoExpressions(text: string, locale = "en"): ExpressionMark[] {
  const english = locale.toLowerCase().startsWith("en");
  const marks: ExpressionMark[] = [];
  const sentences = [...text.matchAll(/[^.!?…]+[.!?…]*/g)];
  let holding = false;
  sentences.forEach((m, k) => {
    const start = m.index + (m[0].length - m[0].trimStart().length);
    const sentence = m[0].trim();
    if (!sentence) return;
    const lexical = english ? LEXICON.find(([re]) => re.test(sentence)) : undefined;
    let set: ExpressionMark | null = null;
    if (k === 0 && english && GREETING.test(sentence)) set = { char: start, name: "happy", intensity: GREET };
    else if (lexical) set = { char: start, name: lexical[1], intensity: lexical[2] };
    else if (/!+$/.test(sentence)) set = { char: start, name: "happy", intensity: EXCLAIM };
    if (set) marks.push(set);
    else if (holding) marks.push({ char: start, name: "neutral", intensity: 0 });
    holding = !!set;
    if (/\?+$/.test(sentence) && !set) {
      const lastWord = sentence.search(/\S+\s*\?+$/);
      marks.push({ char: start + Math.max(0, lastWord), name: "surprised", ...QUESTION });
    }
  });
  return marks;
}

/** The marks of `raw` as `mode` wants them: its tags ("tags"), its tags or
 *  else the automatic mode's guess ("auto"), none ("off"); the text is the
 *  stripped one in every mode. */
export function expressionMarks(raw: string, mode: ExpressionMode, locale?: string): ParsedText {
  const parsed = parseExpressionTags(raw);
  if (mode === "off") return { text: parsed.text, marks: [] };
  if (mode === "auto" && !parsed.marks.length)
    return { text: parsed.text, marks: autoExpressions(parsed.text, locale) };
  return parsed;
}

/** How a widget reads the expressions in a text (data-expressions). */
export type ExpressionMode = "tags" | "auto" | "off";

/** The mode a data-expressions value names; anything else is "tags". */
export function expressionMode(value: string | undefined | null): ExpressionMode {
  const v = (value ?? "").trim().toLowerCase();
  return v === "auto" || v === "off" ? v : "tags";
}

/**
 * What a voice should say for `raw` and the expressions it carries (`mode`,
 * "tags" by default): the text with its tags taken out, and their marks,
 * closed by a release at the text's end when there are any (so a tag's
 * expression ends with the speech). For a caller that speaks a text in one
 * piece (the dashboard's Speak panel's streamed voice).
 */
export function spokenText(raw: string, mode: ExpressionMode = "tags", locale?: string): ParsedText {
  const parsed = expressionMarks(raw, mode, locale);
  if (parsed.marks.length) parsed.marks.push({ char: parsed.text.length, name: "neutral", intensity: 0 });
  return parsed;
}
