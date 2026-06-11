export { AvatarEngine, prepareCues } from "./engine";
export type { EngineOptions } from "./engine";
// NOTE: Avatar3DEngine is intentionally NOT re-exported here — importing it
// pulls Three.js (~600KB) into the consumer bundle. Dashboard and widget
// both load it on demand: import("@liveface/embed/engine3d") / liveface-3d.js.
export { SpeechQueue, splitSentences } from "./speech";
export type { SynthFn, SpeechPlayer } from "./speech";
export { listen, sttSupported } from "./stt";
export type { ListenOptions } from "./stt";
export type { BlendWeights, Cue, Rig, SynthesisPayload } from "./types";
export { ZERO_WEIGHTS, weightsFromLegacy } from "./types";
