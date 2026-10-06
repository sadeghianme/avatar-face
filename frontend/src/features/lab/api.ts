import type { StreamedSpeech } from "@liveface/embed/speech-stream/protocol";

import type { VoiceSelection } from "@/features/voices";
import { api } from "@/lib/api";
import type { Schemas } from "@/lib/types";

/**
 * The lab's requests. Each is one step of a preview's boot or of a test
 * run, abortable or streamed, never cached server state: plain functions
 * rather than query hooks (docs/frontend-ui.md, "Data"). The avatars the
 * lab shows come through the avatars feature's hooks.
 */

/** A temporary lab upload (signed storage, the usual face rig; never
 * published), with the name the page gives it. */
export type ReferenceUpload = Schemas["ReferencePreview"] & { name: string };

/** A portrait, or a photo of the mouth for the photographic one. */
export function uploadReferencePhoto(
  orgId: string,
  purpose: "portrait" | "mouth",
  file: File,
  signal: AbortSignal
): Promise<Schemas["ReferencePreview"]> {
  const form = new FormData();
  form.append("file", file);
  return api.postForm<Schemas["ReferencePreview"]>(
    `/orgs/${orgId}/lab/reference/preview?purpose=${purpose}`,
    form,
    signal
  );
}

/** A test phrase, synthesized whole (the voices that cannot stream). */
export function synthesizeLipSync(
  orgId: string,
  body: { text: string } & VoiceSelection,
  signal: AbortSignal
): Promise<StreamedSpeech> {
  return api.post<StreamedSpeech>(`/orgs/${orgId}/lab/lip-sync/synthesize`, body, signal);
}

/** A test phrase as it is spoken: an NDJSON stream of speech events. */
export function streamLipSync(
  orgId: string,
  body: { text: string } & VoiceSelection,
  signal: AbortSignal
): Promise<Response> {
  return api.stream(`/orgs/${orgId}/lab/lip-sync/stream`, body, signal);
}

/**
 * The face's measured relief for Photoface HD, or null: a miss means the
 * dome fallback, which the comparison can still judge.
 */
export function faceDepth(orgId: string, avatarId: string): Promise<number[] | null> {
  return api
    .get<{ detected: boolean; z: number[] }>(`/orgs/${orgId}/lab/avatars/${avatarId}/depth`)
    .then((depth) => (depth.detected ? depth.z : null))
    .catch(() => null);
}
