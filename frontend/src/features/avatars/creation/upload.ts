/** A creation's upload: what is checked before a byte is sent (see index.ts). */

/** The server's limits (services.creations), checked before a byte is sent. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type FileProblem = "model_file" | "unsupported_image_type" | "image_too_large";

/**
 * Why a file cannot start a creation, or null. The server checks again (and
 * decodes, which is where a 100-megapixel photo is refused); this spares a
 * 15 MB upload that was always going to bounce. A .glb gets its own answer:
 * it is a 3D avatar, which has its own importer on the same page.
 */
export function checkFile(file: { name: string; type: string; size: number }): FileProblem | null {
  if (file.name.toLowerCase().endsWith(".glb") || file.type === "model/gltf-binary") {
    return "model_file";
  }
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) return "unsupported_image_type";
  if (file.size > MAX_UPLOAD_BYTES) return "image_too_large";
  return null;
}

/** "holiday-2024.final.jpg" → "holiday-2024.final": a starting name only. */
export function nameFromFile(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .trim()
    .slice(0, 128);
}
