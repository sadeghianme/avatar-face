/**
 * The API's shapes, as the dashboard reads them: the backend's own schemas
 * (api-types.ts, generated from its OpenAPI document by `npm run gen:api`)
 * under the names the code uses. Where the server types a field loosely (a
 * dict, a plain string), `Refine` says it precisely here, and may name only
 * fields the schema has: a field renamed or dropped on the server fails
 * tsc instead of reading `undefined`. Hand-written whole: what the server
 * answers with an untyped dict (Usage).
 */
import type { components } from "@/lib/api-types";

/** Every schema of the API, by name. */
export type Schemas = components["schemas"];

/** `Base` with the fields in `Fields` replaced by their precise types;
 *  `Fields` must name fields `Base` has. */
export type Refine<Base, Fields extends { [K in keyof Fields]: K extends keyof Base ? unknown : never }> = Omit<
  Base,
  keyof Fields
> &
  Fields;

/** A request schema whose fields with a server default may be left out
 *  (the generated types make a defaulted field required, as it is in an
 *  answer). */
export type WithDefaults<T, Defaulted extends keyof T> = Omit<T, Defaulted> & Partial<Pick<T, Defaulted>>;

export type Role = Schemas["Role"];
export type User = Schemas["UserOut"];
/** `third_party_ai_enabled`: owners and admins can switch off every step
 *  that sends a picture to a third-party AI (Google). */
export type Org = Schemas["OrgWithRole"];
export type Member = Schemas["MemberOut"];
export type Invitation = Schemas["InviteOut"];

export type AvatarStatus = Schemas["AvatarStatus"];
export type AvatarKind = Schemas["AvatarKind"];
export type MouthRenderer = Schemas["MouthUpdate"]["renderer"];
export type FaceType = NonNullable<Schemas["AvatarUpdate"]["face_type"]>;
export type Framing = NonNullable<Schemas["AvatarUpdate"]["framing"]>;

/**
 * An avatar: the list's fields (AvatarOut), and the detail's signed asset
 * URLs and draft state (AvatarDetail), which the list leaves out.
 *
 * - `quality_note`: a ready avatar that may still look wrong, and why.
 * - `original_image_key`: set when the background has been removed.
 * - `framing`: how embedding sites render it, kept in step with the
 *   scene's zoom; the scene is what is edited now.
 * - `precrop_image_key`: non-null when the crop can be reset.
 * - `undo_label`: names the change an undo would reverse.
 * - `unpublished`: the draft has changes visitors do not see.
 * - `published`: visitors are served a snapshot. Ask "is it live" with
 *   this, not `published_at`: snapshots from before explicit publishing are
 *   live and have no date.
 * - `render_profile`: the draft rig's render profile ("toon@1", "animal@2",
 *   the older "animal@1", or none: the classic renderer).
 * - `share_token`: a public page exists at /s/<token>.
 * - `preparing_creation_id`: the creation whose finish is still building
 *   it (the wizard's step 5); its page follows the build there.
 */
export type Avatar = Refine<
  Schemas["AvatarDetail"],
  {
    face_type: FaceType;
    framing: Framing;
    /** The DRAFT scene (features/avatars/scene): zoom 1 is the face view, 0
     *  the whole picture; pan moves the view; the background sits behind a
     *  cut-out. Null for an avatar made before scenes, rendered by its
     *  framing. */
    scene?: {
      zoom: number;
      pan: { x: number; y: number };
      background: { kind: "transparent" | "color" | "image"; color?: string; has_image: boolean };
    } | null;
    /** The draft voice; published on Publish. */
    voice?: Schemas["VoiceConfig"] | null;
    /** Detail only: the draft teeth photo and its rig, presigned. */
    mouth_photo?: { image_url: string; rig_url: string } | null;
    /** The DRAFT mouth; null means the classic drawn mouth. */
    mouth?: AvatarMouth | null;
    /** An AI made or changed the picture: disclosed with the avatar. */
    ai_edited?: AiEdited | null;
  }
>;

export interface AvatarMouth {
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
   *  (never served to visitors); null when none was made. */
  kit?: MouthKit | null;
  /** How an animation's or an animal's character mouth is set (teeth,
   *  tongue, jaw); absent until the owner has set it. */
  character?: Partial<Schemas["CharacterUpdate"]> | null;
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

export type Provider = Schemas["ProviderOut"];
export type Voice = Schemas["VoiceOut"];
export type Synthesis = Schemas["SynthesizeResponse"];
export type ApiKeyInfo = Schemas["ApiKeyOut"];
export type StockAvatar = Schemas["StockAvatarOut"];

export type IntegrationField = Refine<Schemas["FieldStatus"], { source: "db" | "env" | "unset" }>;

/** A provider's settings: `kind` decides the section and what Test does. */
export type Integration = Refine<Schemas["ProviderStatus"], { kind: "voice" | "image"; fields: IntegrationField[] }>;

/** GET /orgs/{id}/usage answers a dict (no response model yet): typed here. */
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
