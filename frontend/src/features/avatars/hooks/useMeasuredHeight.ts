import { useCallback, useRef, useState } from "react";

/**
 * An element's height, measured and kept current (ResizeObserver): give
 * `ref` to the element. The avatar page sizes its sticky stage to what the
 * window leaves under its page head, whether the head's row of actions
 * wraps or not.
 */
export function useMeasuredHeight(initial: number) {
  const [height, setHeight] = useState(initial);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setHeight(el.offsetHeight);
    observer.current = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.current.observe(el);
  }, []);
  return { height, ref };
}
