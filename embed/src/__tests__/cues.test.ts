import { describe, expect, it } from "vitest";

import { prepareCues } from "../engine";
import { splitSentences } from "../speech";
import { estimatedCues } from "../browser-tts";
import type { Cue } from "../types";

const cue = (t: number, viseme: string, a = 1): Cue => ({ t, viseme, a });

describe("prepareCues", () => {
  it("always ends closed, at the track's true end", () => {
    // An open mouth left behind after the audio stops is the single most
    // noticeable lip-sync bug there is.
    const out = prepareCues([cue(0, "aa"), cue(200, "E"), cue(400, "oh")]);
    expect(out[out.length - 1].viseme).toBe("sil");
    expect(out[out.length - 1].t).toBeGreaterThanOrEqual(400);
  });

  it("keeps consonants that a vowel would otherwise swallow", () => {
    // Transients are the whole intelligibility of a sentence: fold them at
    // the vowel dwell rate and "the little girl" mimes as one vowel smear.
    const out = prepareCues([
      cue(0, "sil"),
      cue(100, "DD"),
      cue(145, "aa"), // 45ms later — under the vowel floor, over the transient one
      cue(400, "sil"),
    ]);
    expect(out.map((c) => c.viseme)).toContain("DD");
    expect(out.map((c) => c.viseme)).toContain("aa");
  });

  it("lets a vowel win a genuine collision, and takes its whole cue", () => {
    // The old in-place assignment copied only the viseme, so a vowel could
    // inherit the consonant's stress amplitude and be drawn at the wrong size.
    const out = prepareCues([
      cue(0, "sil"),
      cue(100, "kk", 0.2),
      cue(105, "aa", 0.9),
      cue(400, "sil"),
    ]);
    const vowel = out.find((c) => c.viseme === "aa");
    expect(vowel).toBeDefined();
    expect(vowel!.a).toBe(0.9);
  });

  it("drops repeats but never reorders time", () => {
    const out = prepareCues([
      cue(0, "sil"), cue(120, "aa"), cue(240, "aa"), cue(360, "E"), cue(600, "sil"),
    ]);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].t).toBeGreaterThan(out[i - 1].t);
    }
    expect(out.filter((c) => c.viseme === "aa").length).toBe(1);
  });

  it("passes trivial tracks through untouched", () => {
    const track = [cue(0, "sil"), cue(100, "sil")];
    expect(prepareCues(track)).toEqual(track);
  });
});

describe("splitSentences", () => {
  it("splits on sentence ends and keeps the punctuation", () => {
    const out = splitSentences(
      "This is a full length sentence. And here is another complete one? "
      + "Finally a third that is long enough!"
    );
    expect(out).toEqual([
      "This is a full length sentence.",
      "And here is another complete one?",
      "Finally a third that is long enough!",
    ]);
  });

  it("merges fragments too short to synthesize on their own", () => {
    // Deliberate: sending "Fine!" as its own request produces a clipped,
    // choppy clip and an extra round trip. Pinned because it looks like a
    // splitting bug to anyone who has not read the reason.
    expect(splitSentences("Hello there. How are you? Fine!")).toEqual([
      "Hello there. How are you? Fine!",
    ]);
  });

  it("keeps every character of the input", () => {
    // Chunking drives synthesis; a dropped clause is silently never spoken.
    const text = "First one. Second one, with a comma; and a semicolon! Third?";
    const joined = splitSentences(text).join(" ").replace(/\s+/g, " ");
    expect(joined).toBe(text.replace(/\s+/g, " "));
  });

  it("wraps very long text instead of emitting one enormous chunk", () => {
    const long = "word ".repeat(400).trim();
    const out = splitSentences(long);
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(220);
  });

  it("ignores blank lines and whitespace", () => {
    expect(splitSentences("\n\n   \n")).toEqual([]);
    expect(splitSentences("  Hi.  ")).toEqual(["Hi."]);
  });
});

describe("estimatedCues", () => {
  it("spans the duration it was given and ends closed", () => {
    // The browser-voice fallback when the cue endpoint is unreachable. If it
    // runs short the mouth stops while the voice keeps going.
    const cues = estimatedCues("Hello there, how are you today?", 3000);
    expect(cues[0].t).toBe(0);
    expect(cues[cues.length - 1].viseme).toBe("sil");
    expect(cues[cues.length - 1].t).toBeLessThanOrEqual(3000);
    expect(cues[cues.length - 1].t).toBeGreaterThan(2000);
  });

  it("never emits time going backwards", () => {
    const cues = estimatedCues("A somewhat longer sentence, with punctuation!", 5000);
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].t).toBeGreaterThanOrEqual(cues[i - 1].t);
    }
  });
});
