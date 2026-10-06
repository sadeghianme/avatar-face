import { DEFAULT_REFERENCE_PROFILE } from "@liveface/embed/mouth/reference-mouth-model";

import type { Avatar } from "@/lib/types";

/** Initial fitting pass for the bundled portrait, still subject to review. */
export const REFERENCE_AVATAR_PROFILE = { ...DEFAULT_REFERENCE_PROFILE, teethY: 0.016 };
export const REFERENCE_RENDERER_VERSION = "lip-coverage-v1";
/** The reference lab's script box: "Test this photo" jumps to it. */
export const REFERENCE_SCRIPT_ID = "reference-script";

/** Bundled fictional sample, not a saved customer avatar or database record. */
export const REFERENCE_AVATAR: Avatar = {
  id: "lab-reference-v1",
  org_id: "",
  name: "Reference portrait",
  kind: "photo",
  status: "ready",
  content_type: "image/png",
  error: null,
  created_at: "2026-09-06T00:00:00Z",
  updated_at: "2026-09-06T00:00:00Z",
  image_url: "/lab/reference/portrait.png",
  rig_url: "/lab/reference/rig.json",
  framing: "full",
};
