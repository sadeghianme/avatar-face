import { DEFAULT_REFERENCE_PROFILE, normalizeProfile, type ReferenceProfile } from "@liveface/embed/lab/reference-mouth-model";
import { useState } from "react";

/** Explicit local drafts only. Never writes the avatar, rig, or organisation. */
export function useReferenceProfile(orgId: string, avatarId: string, initial = DEFAULT_REFERENCE_PROFILE) {
  const key = `liveface:reference-mouth:v1:${orgId}:${avatarId}`;
  const [profile, setProfile] = useState<ReferenceProfile>(() => {
    try { const saved = localStorage.getItem(key); return saved ? normalizeProfile(JSON.parse(saved)) : { ...initial }; }
    catch { return { ...initial }; }
  });
  const [status, setStatus] = useState<"idle" | "saved" | "failed">("idle");
  const update = (next: ReferenceProfile) => { setStatus("idle"); setProfile(normalizeProfile(next)); };
  const save = () => {
    try { localStorage.setItem(key, JSON.stringify(profile)); setStatus("saved"); }
    catch { setStatus("failed"); }
  };
  return { profile, update, save, status, reset: () => update({ ...initial }) };
}
