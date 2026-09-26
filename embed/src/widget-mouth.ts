/**
 * The continuous mouth as a lazy bundle, loaded by the widget only for
 * avatars that use it — the same arrangement as liveface-3d.js, and for the
 * same reason: every other avatar's visitors should not download it.
 *
 * The avatar's mouth config is handed on whole, so its own performance
 * manifest (`motion_url`) reaches the loader; `motionUrl` is the bundled
 * Reference motion, played when there is none, and the standard teeth are
 * found beside it.
 */
import { attachAvatarMouth } from "./mouth";

window.__LivefaceMouth = { attach: (engine, config, motionUrl) => attachAvatarMouth(engine, config, motionUrl) };
