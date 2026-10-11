import { describe, expect, it, vi } from "vitest";

import type { ExpressionCue } from "../engine/expression-mixer";
import { EXPRESSION_LEAD_MS } from "../expression-markup";
import { SpeechQueue, speechChunks, type SpeechPlayer, type SynthFn } from "../speech";
import type { Cue, SynthesisPayload } from "../types";

/** A text's tags through the server voice's queue (speech.ts): stripped
 *  before the voice, kept out of the sentence split, timed by the word
 *  marks the answer carries, released at the text's end. */
describe("a text's expressions in its chunks", () => {
  it("keep a tag with a decimal whole across the sentence split", () => {
    const chunks = speechChunks(
      "Hello there, my good friend! [surprised:0.8] Really, is that so, my friend? I did not know it at all."
    );
    expect(chunks.map((c) => c.text)).toEqual([
      "Hello there, my good friend!",
      "Really, is that so, my friend?",
      "I did not know it at all.",
    ]);
    expect(chunks[1].marks[0]).toEqual({ char: 0, name: "surprised", intensity: 0.8 });
  });

  it("carry a chunk of tags alone to the next, and release at the end of the last", () => {
    const chunks = speechChunks("[happy]\nThis is the first sentence here. And the second one is here.");
    expect(chunks[0].marks[0]).toMatchObject({ char: 0, name: "happy" });
    const last = chunks[chunks.length - 1];
    expect(last.marks[last.marks.length - 1]).toEqual({ char: last.text.length, name: "neutral", intensity: 0 });
  });

  it("add nothing to a text without tags, unless asked for the automatic mode", () => {
    expect(speechChunks("Just a plain sentence that is long enough.").every((c) => !c.marks.length)).toBe(true);
    const auto = speechChunks("Hello, it is nice to meet you today!", "auto", "en-US");
    expect(auto[0].marks.map((m) => m.name)).toEqual(["happy", "neutral"]);
    expect(speechChunks("Hi there [happy] friend, how are you doing?", "off")[0]).toEqual({
      text: "Hi there friend, how are you doing?",
      marks: [],
    });
  });
});

describe("the speech queue with expressions", () => {
  const cues: Cue[] = [
    { t: 0, viseme: "sil" },
    { t: 900, viseme: "sil" },
  ];
  const payload = (text: string, marks: boolean): SynthesisPayload => ({
    audio_b64: "",
    audio_mime: "audio/wav",
    cached: false,
    cues,
    duration_ms: 1000,
    ...(marks
      ? {
          word_marks: [
            { char: 0, t: 0 },
            { char: text.indexOf("glad"), t: 600 },
          ],
        }
      : {}),
  });

  it("asks for word marks only for a chunk with expressions, and hands the track to the player", async () => {
    const played: { cues: Cue[]; track?: ExpressionCue[] }[] = [];
    const player: SpeechPlayer = {
      playAudio: (_b64, _mime, c, onEnd, track) => {
        played.push({ cues: c, track });
        onEnd?.();
      },
      stopSpeech: vi.fn(),
    };
    const synth = vi.fn<SynthFn>(async (text, options) => payload(text, !!options?.wordMarks));
    await new SpeechQueue(player, synth).speak("A first sentence with no tag. Then I am [happy] glad to see you.");
    expect(synth.mock.calls).toEqual([
      ["A first sentence with no tag."],
      ["Then I am glad to see you.", { wordMarks: true }],
    ]);
    expect(played[0].track).toBeUndefined();
    expect(played[1].track).toEqual([
      { t: 600 - EXPRESSION_LEAD_MS, name: "happy", intensity: 1 },
      { t: 1000, name: "neutral", intensity: 0 },
    ]);
  });

  it("passes the player exactly what it passed before for a text without tags", async () => {
    const playAudio = vi.fn<SpeechPlayer["playAudio"]>((_a, _m, _c, onEnd) => onEnd?.());
    await new SpeechQueue({ playAudio, stopSpeech: vi.fn() }, async (t) => payload(t, false)).speak("Plain words.");
    expect(playAudio.mock.calls[0]).toHaveLength(4);
  });
});
