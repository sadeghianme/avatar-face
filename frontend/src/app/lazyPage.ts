import { ComponentType, lazy, LazyExoticComponent } from "react";

const RELOADED = "liveface.chunkReload";

function flag(action: "get" | "set" | "clear"): boolean {
  try {
    if (action === "get") return sessionStorage.getItem(RELOADED) === "1";
    if (action === "set") sessionStorage.setItem(RELOADED, "1");
    else sessionStorage.removeItem(RELOADED);
  } catch {
    // storage blocked: behave as if we already reloaded, so we never loop
    return action === "get";
  }
  return false;
}

/**
 * React.lazy for a route screen that survives a deploy.
 *
 * index.html is never cached, but a tab opened before a deploy still asks
 * for the previous build's chunk names, and those files are gone. The first
 * failure reloads the page once, which fetches the new index.html and its
 * chunks; a second failure is real and reaches the error boundary.
 */
export function lazyPage<P extends object>(
  load: () => Promise<ComponentType<P>>
): LazyExoticComponent<ComponentType<P>> {
  return lazy(async () => {
    try {
      const component = await load();
      flag("clear");
      return { default: component };
    } catch (error) {
      if (!flag("get")) {
        flag("set");
        window.location.reload();
        return new Promise<never>(() => undefined); // the reload takes over
      }
      throw error;
    }
  });
}
