/**
 * liveface-3d.js — secondary bundle carrying Three.js + the 3D engine.
 * Lazy-loaded by liveface.js only when an avatar is kind=model3d, so photo
 * avatars keep the featherweight (~13KB) widget.
 */
import { Avatar3DEngine } from "./engine3d";

declare global {
  interface Window {
    __Liveface3D?: {
      load: (canvas: HTMLCanvasElement, modelUrl: string) => Promise<Avatar3DEngine>;
    };
  }
}

window.__Liveface3D = { load: (canvas, modelUrl) => Avatar3DEngine.load(canvas, modelUrl) };

export { Avatar3DEngine };
