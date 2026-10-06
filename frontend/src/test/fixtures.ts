/**
 * The API's records for the rendering tests, each with the fields a case
 * changes. Creations have their own builders (features/avatars/creation/
 * fixtures.ts), shared with the node --test suite.
 */
import type { Avatar, Org, User } from "@/lib/types";

export const ORG_ID = "org1";

export function aUser(extra: Partial<User> = {}): User {
  return {
    id: "u1",
    email: "ana@example.com",
    username: "ana",
    display_name: "Ana",
    created_at: "2026-09-01T10:00:00Z",
    ...extra,
  };
}

export function anOrg(extra: Partial<Org> = {}): Org {
  return {
    id: ORG_ID,
    name: "Studio",
    created_at: "2026-09-01T10:00:00Z",
    role: "owner",
    third_party_ai_enabled: true,
    ...extra,
  };
}

/** A ready, published photo avatar with a rig, as its detail returns it. */
export function anAvatar(extra: Partial<Avatar> = {}): Avatar {
  return {
    id: "av1",
    org_id: ORG_ID,
    name: "Maya",
    status: "ready",
    kind: "photo",
    content_type: "image/png",
    error: null,
    quality_note: null,
    created_at: "2026-09-20T10:00:00Z",
    updated_at: "2026-09-20T10:00:00Z",
    image_url: "/api/storage/orgs/org1/avatars/av1/image.png",
    thumbnail_url: "/api/storage/orgs/org1/avatars/av1/thumb.png",
    rig_url: "/api/storage/orgs/org1/avatars/av1/rig.json",
    original_image_key: null,
    framing: "face",
    scene: null,
    precrop_image_key: null,
    undo_label: null,
    unpublished: false,
    published: true,
    published_at: "2026-09-20T11:00:00Z",
    face_type: "human",
    voice: null,
    mouth_photo: null,
    mouth: null,
    render_profile: null,
    share_token: null,
    layer_urls: null,
    model_url: null,
    ai_edited: null,
    preparing_creation_id: null,
    ...extra,
  };
}
