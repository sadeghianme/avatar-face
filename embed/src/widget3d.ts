/**
 * liveface-3d.js — secondary bundle carrying Three.js + the 3D engine.
 * Lazy-loaded by liveface.js only when an avatar is kind=model3d, so photo
 * avatars keep the featherweight widget. `options` carries the widget's
 * `debug` (engine/debug-handle.ts); a liveface.js from before it passes
 * none, and an older liveface-3d.js ignores it.
 *
 * A model's KTX2 textures are decoded with the transcoder the build copies
 * beside this bundle (scripts/build.mjs), so it is fetched from wherever
 * this bundle was, the API, and never from a CDN.
 */
import { Avatar3DEngine, type Avatar3DOptions } from "./engine3d";

declare global {
  interface Window {
    __Liveface3D?: {
      load: (canvas: HTMLCanvasElement, modelUrl: string, options?: Avatar3DOptions) => Promise<Avatar3DEngine>;
    };
  }
}

/** This bundle's own directory: read as it runs, the only time
 *  document.currentScript is this script. */
const here = (document.currentScript as HTMLScriptElement | null)?.src;
const transcoderPath = here ? new URL("./", here).href : undefined;

window.__Liveface3D = {
  load: (canvas, modelUrl, options) => Avatar3DEngine.load(canvas, modelUrl, { transcoderPath, ...options }),
};

export { Avatar3DEngine };
