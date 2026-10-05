/**
 * Lighting that matches the picture rather than relighting it.
 *
 * A photograph already carries its lighting in its pixels. Lit by the
 * engine's default (a 1.4 hemisphere and a 1.6 key, tuned for PBR avatar
 * skins) it comes out twice as bright. So a photo gets a near-flat
 * hemisphere of about one, which shows the texture at its own brightness,
 * and a soft key that adds just enough shading for a turn to read as depth.
 * A 3D render may take a stronger key; cel art is unlit by its materials
 * and the lights do not reach it.
 */
import type { Avatar3DOptions } from "../engine3d";
import type { Head3DLook } from "./extras";

/**
 * three.js lights are physical: a Lambert surface reflects albedo x
 * irradiance / pi, so an intensity of pi lights a surface facing the light
 * to exactly its texture colour. The presets are written as the share of
 * the texture's brightness each light contributes to a surface facing the
 * camera (hemisphere: the sky/ground mix at a sideways normal is 0.5 each;
 * key: it stands at (0.5, 1.2, 1.5), 0.78 of the way toward the camera) and
 * scaled by pi here, so "photo" shows the picture at its own brightness
 * head-on and shades the sides a little as they turn away from the key.
 */
const KEY_TOWARD_CAMERA = 1.5 / Math.hypot(0.5, 1.2, 1.5);

function preset(hemisphereShare: number, keyShare: number, ground: number): NonNullable<Avatar3DOptions["lights"]> {
  const groundLevel = ((ground >> 16) & 255) / 255;
  const hemisphereMix = (1 + groundLevel) / 2;
  return {
    hemisphere: (hemisphereShare / hemisphereMix) * Math.PI,
    key: (keyShare / KEY_TOWARD_CAMERA) * Math.PI,
    groundColor: ground,
  };
}

export const LIGHTS: Record<Head3DLook, NonNullable<Avatar3DOptions["lights"]>> = {
  photo: preset(0.82, 0.18, 0xc8c8c8),
  render: preset(0.68, 0.32, 0xa0a0b0),
  flat: preset(1.0, 0.0, 0xffffff),
};

export function lightsFor(look: Head3DLook): NonNullable<Avatar3DOptions["lights"]> {
  return { ...LIGHTS[look] };
}
