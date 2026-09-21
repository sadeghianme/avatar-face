/**
 * The continuous mouth as a lazy bundle, loaded by the widget only for
 * avatars that use it — the same arrangement as liveface-3d.js, and for the
 * same reason: every other avatar's visitors should not download it.
 */
import { attachAvatarMouth } from "./mouth";

window.__LivefaceMouth = { attach: (engine, config, motionUrl) => attachAvatarMouth(engine, config, motionUrl) };
