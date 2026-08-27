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
  published_at?: string | null;
  /** Set means a public page exists at /s/<token>. */
  share_token?: string | null;
  /** Background/body/head decomposition for the layered render path. */
  layer_urls?: Record<string, string> | null;
  rig_url?: string | null;
  thumbnail_url?: string | null;
  model_url?: string | null;
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
