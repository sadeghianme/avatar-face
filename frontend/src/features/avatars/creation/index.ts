/**
 * A creation: one photo on its way to an avatar, as the creations API
 * returns it, and the rules the wizard reads off it.
 *
 * Everything here is framework-free and imports nothing at runtime but
 * its own parts, so the
 * wizard's decisions (which step to open, when to poll, whether the marks
 * still belong to the image) are tested with `node --test` rather than by
 * clicking through the flow. The components only render what these say.
 *
 * One file per part of the wizard's model, as the sections of the old
 * creation.ts were; this index is the module (`@/features/avatars/creation`).
 * Runtime imports between the parts are relative, with their `.ts`, so
 * `node --test` runs them as they are.
 */

export * from "./adjust.ts";
export * from "./errors.ts";
export * from "./finish-notice.ts";
export * from "./framing.ts";
export * from "./images.ts";
export * from "./jobs.ts";
export * from "./marks.ts";
export * from "./photo-findings.ts";
export * from "./polling.ts";
export * from "./types.ts";
export * from "./upload.ts";
