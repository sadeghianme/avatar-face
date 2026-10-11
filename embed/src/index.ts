export { AvatarEngine, prepareCues } from "./engine";
export type { EngineOptions, HeadMotionMode, Scene, SceneBackground, WarpMode } from "./engine";
export { ZOOM_MAX, PAN_MAX } from "./engine/viewport";
export type { ExpressionCue, ExpressionState, ExpressionTiming } from "./engine/expression-mixer";
export { EXPRESSION_NAMES, expressionNamed, type ExpressionName } from "./engine/expression-table";
export { parseExpressionTags, timeExpressionMarks, autoExpressions, spokenText } from "./expression-markup";
export type { ExpressionMark, ParsedText } from "./expression-markup";
// NOTE: Avatar3DEngine is intentionally NOT re-exported here — importing it
// pulls Three.js (~600KB) into the consumer bundle. Dashboard and widget
// both load it on demand: import("@liveface/embed/engine3d") / liveface-3d.js.
export { SpeechQueue, splitSentences } from "./speech";
export type { SynthFn, SpeechPlayer } from "./speech";
export { BrowserTTS, estimatedCues } from "./browser-tts";
export type { CuePlayer } from "./browser-tts";
export { listen, sttSupported } from "./stt";
export type { ListenOptions } from "./stt";
export type { BlendWeights, Cue, EngineTuning, FaceType, Rig, SynthesisPayload } from "./types";
export { DEFAULT_TUNING, ZERO_WEIGHTS, weightsFromLegacy } from "./types";
export { SpeechError, streamSpeech, StreamingSpeechPlayer } from "./speech-stream";
export type { StreamHandle, StreamOptions } from "./speech-stream";
export type { CharacterSettings, ClassicMouthConfig } from "./engine/character-mouth";
