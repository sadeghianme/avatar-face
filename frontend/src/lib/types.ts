export type Role = "owner" | "admin" | "member";

export interface User {
  id: string;
  email: string;
  username: string;
  display_name: string;
}

export interface Org {
  id: string;
  name: string;
  created_at: string;
  role: Role;
  /** Owners and admins can switch off every step that sends a picture to
   * a third-party AI (Google). Every line still works by hand without. */
  third_party_ai_enabled?: boolean;
}

export interface Member {
  membership_id: string;
  user_id: string;
  username: string;
  email: string;
  display_name: string;
  role: Role;
  joined_at: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  token: string;
  created_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export type AvatarStatus = "pending" | "processing" | "ready" | "failed";
export type AvatarKind = "photo" | "model3d";

export type MouthRenderer = "classic" | "continuous";

export type FaceType = "human" | "animal" | "cartoon";

export interface Avatar {
  id: string;
  org_id: string;
  name: string;
  status: AvatarStatus;
  kind: AvatarKind;
  content_type: string;
  error: string | null;
  /** A ready avatar that may still look wrong, and why. */
  quality_note?: string | null;
  created_at: string;
  updated_at: string;
  image_url?: string | null;
  /** Set when the background has been removed — the pre-cut-out photo. */
  original_image_key?: string | null;
  /** How embedding sites render it: cropped to the head, or the whole photo. */
  framing?: "face" | "full";
  /** Non-null means the photo has been cropped and the crop can be reset. */
  precrop_image_key?: string | null;
  /** Names the change an undo would reverse; absent when there is nothing. */
  undo_label?: string | null;
  /** True when the draft has unpublished changes. */
  unpublished?: boolean;
  /** True while visitors are served a snapshot. Use this to ask "is it
   *  live", not published_at: snapshots from before explicit publishing are
   *  live and have no date. */
  published?: boolean;
  /** When the owner last pressed Publish; null for those older snapshots. */
  published_at?: string | null;
  /** Selects the viseme table, and which mouth renderers are allowed. */
  face_type?: FaceType;
  /** The avatar's draft voice {provider, voice, locale}; published on Publish. */
  voice?: { provider: string; voice: string; locale: string } | null;
  /** The DRAFT mouth; null means the classic drawn mouth. */
  /** Detail only: presigned draft teeth photo + its rig. */
  mouth_photo?: { image_url: string; rig_url: string } | null;
  mouth?: {
    renderer: MouthRenderer;
    profile: Record<string, number>;
    has_oral_photo: boolean;
    /** Where the teeth photo came from ("ai": made from the avatar's
     *  picture; "upload": the owner's), or null with the reason a new avatar
     *  has the standard teeth. Absent from a server before it said so. */
    teeth?: TeethRecord;
    /** Presigned: the draft's own performance manifest (its six mouth
     *  shapes, docs/performance-kit.md). The path changes with every new
     *  kit, rebase or discard. Null or absent: the bundled motion. */
    motion_url?: string | null;
    /** What the mouth kit behind `motion_url` is made of, for the owner
     *  (never served to visitors); null when none was made. Absent from a
     *  server before it said so. */
    kit?: MouthKit | null;
  } | null;
  /** Set means a public page exists at /s/<token>. */
  share_token?: string | null;
  /** Background/body/head decomposition for the layered render path. */
  layer_urls?: Record<string, string> | null;
  rig_url?: string | null;
  thumbnail_url?: string | null;
  model_url?: string | null;
  /** An AI made or changed the picture: disclosed with the avatar. */
  ai_edited?: AiEdited | null;
  /** Detail only: the creation whose finish is still building this avatar
   *  (the wizard's step 5, "Preparing your avatar"); its page follows the
   *  build there. Absent from a server before it said so. */
  preparing_creation_id?: string | null;
}

/** How an AI was involved in an avatar, as it is disclosed. `mode` is what
 *  it did to the picture; when it did nothing there, "teeth" (it made the
 *  teeth photo) or else "mouth_shapes" (it made some of the mouth shapes).
 *  `teeth` and `mouth_shapes` say so beside any mode; `mouth_shapes` only
 *  counts shapes an AI drew, never the standard ones fitted to the face. */
export interface AiEdited {
  mode: "touchup" | "stylise" | "regenerate" | "generate" | "teeth" | "mouth_shapes";
  model: string | null;
  teeth?: { model: string | null };
  mouth_shapes?: { model: string | null; generated: number };
}

/** A reason, as the server gives one: a code to word, and its sentence;
 *  `reason`, the check behind it (a teeth photo that did not pass one). */
export interface Reason {
  code: string;
  detail: string;
  reason?: Reason | null;
}

/** The avatar's teeth photo: who made it, or why there is none. */
export interface TeethRecord {
  source: "ai" | "upload" | null;
  note: Reason | null;
}

/** The six mouth shapes a kit makes, in the manifest's order. */
export type MouthShape = "aa" | "ee" | "oo" | "oh" | "fv" | "th";

/**
 * A mouth kit, as the owner is told about it (services.mouth_kit
 * .public_kit): the person's own mouth shapes, made by AI from the avatar's
 * picture ("generated"), or the standard one fitted to the face where a
 * shape could not be made ("retargeted", with why). "dropped": it could not
 * follow the face's points, so the standard motion plays again; the teeth
 * stay.
 */
export interface MouthKit {
  state: "made" | "dropped";
  made_at: string;
  model: string | null;
  generated: number;
  retargeted: number;
  /** Always the six, in aa, ee, oo, oh, fv, th order. */
  shapes: { shape: MouthShape; provenance: "generated" | "retargeted"; reason: Reason | null }[];
  /** Whether its teeth photo is the avatar's, and why not when it is not. */
  teeth: { used: boolean; reason: Reason | null };
  dropped: Reason | null;
}

export interface Provider {
  name: string;
  display_name: string;
}

export interface Voice {
  id: string;
  name: string;
  locale: string;
  gender: string;
}

export interface Synthesis {
  audio_b64: string;
  audio_mime: string;
  duration_ms: number;
  cues: { t: number; viseme: string }[];
  cached: boolean;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  allowed_domains: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface Usage {
  /** Attempts this month — what is charged, including rejected candidates. */
  images_generated?: number;
  image_limit?: number;
  /** Candidates actually kept as avatars. */
  avatars_generated?: number;
  image_cost_usd?: number;
  /** AI point finding this month (a vision model call per look). */
  vision_points?: number;
  vision_points_limit?: number;
  month_start: string;
  chars_used: number;
  char_limit: number;
  by_provider: { provider: string; syntheses: number; chars: number }[];
}

export interface IntegrationField {
  name: string;
  masked: string;
  source: "db" | "env" | "unset";
}

export interface Integration {
  provider: string;
  /** "voice" or "image" — decides the section and what Test does. */
  kind: "voice" | "image";
  fields: IntegrationField[];
  configured: boolean;
}

export interface StockAvatar {
  id: string;
  name: string;
  image_url: string;
}
