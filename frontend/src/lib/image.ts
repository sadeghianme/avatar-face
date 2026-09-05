/**
 * Load an image for canvas use.
 *
 * `crossOrigin` is the whole reason this is one function: without it a
 * texture from the storage origin taints the canvas, and every colour
 * sample in the engine (lip colour, lash colour, background fill) silently
 * fails with the default value. Two copies of this drifted apart once.
 */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load image"));
    img.src = url;
  });
}
