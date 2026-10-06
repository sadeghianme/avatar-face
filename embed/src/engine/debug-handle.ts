/**
 * The console handles: `globalThis.__liveface` (the 2D engine) and
 * `globalThis.__liveface3d` (the 3D engine), for forcing a blink from the
 * console and for measurement scripts that read the landmarks or the warp
 * path. Set only when a page asks (EngineOptions.debug, Avatar3DOptions.debug;
 * the widget's `data-debug`), so a customer's page gets no globals from the
 * engine, and taken back by the engine that set it when it is destroyed, so
 * an unmounted engine (its picture, textures and audio) is not kept alive.
 * The last engine made wins; destroying an older one leaves the newer
 * engine's handle where it is.
 */
export type DebugHandleName = "__liveface" | "__liveface3d";

/** Put `engine` on `globalThis[name]`; the function returned takes it back. */
export function exposeDebugHandle(name: DebugHandleName, engine: object): () => void {
  const scope = globalThis as Record<string, unknown>;
  scope[name] = engine;
  return () => {
    if (scope[name] === engine) delete scope[name];
  };
}

/** For an engine made without the handle: nothing to take back. */
export const NO_DEBUG_HANDLE = (): void => undefined;
