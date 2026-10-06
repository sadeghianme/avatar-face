import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { expandVisemeTable, readHead3DExtras } from "../extras";
import { FixedHeadPose, HEAD_POSE_RANGE, IdleHeadPose } from "../head-pose";
import { LIGHTS, lightsFor } from "../lighting";
import { optionsFor } from "../load";

describe("what a head3d GLB tells the engine", () => {
  const extras = {
    version: 1,
    kind: "head3d",
    subject: "x",
    look: "render",
    profile: "toon@1",
    visemes: { aa: { jawOpen: 0.85, mouthStretch: 0.2 }, sil: { mouthClose: 0.1 } },
    frame: { center: [0, 0.02, 0.03], height: 0.3 },
    face_width_m: 0.14,
    morphs: ["jawOpen"],
  };

  it("reads its extras from the scene and ignores any other model", () => {
    const scene = new THREE.Group();
    expect(readHead3DExtras(scene)).toBeNull();
    scene.userData = { liveface: extras };
    const read = readHead3DExtras(scene)!;
    expect(read.look).toBe("render");
    expect(read.profile).toBe("toon@1");
    expect(read.frame.height).toBe(0.3);
    scene.userData = { liveface: { ...extras, look: "watercolour" } };
    expect(readHead3DExtras(scene)!.look).toBe("photo"); // an unknown look is a photo
    scene.userData = { liveface: { kind: "head3d" } };
    expect(readHead3DExtras(scene)).toBeNull(); // no table, no frame: not usable
  });

  it("expands the rig's symmetric table to both ARKit sides", () => {
    const table = expandVisemeTable(extras.visemes);
    expect(table.aa).toEqual({ jawOpen: 0.85, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 });
    expect(table.sil).toEqual({ mouthClose: 0.1 });
  });

  it("turns the extras into engine options, and nothing for another model", () => {
    const options = optionsFor(readHead3DExtras(Object.assign(new THREE.Group(), { userData: { liveface: extras } })));
    expect(options.visemes!.aa.jawOpen).toBe(0.85);
    expect(options.lights).toEqual(LIGHTS.render);
    expect(options.frame).toEqual(extras.frame);
    expect(options.headPose).toBeInstanceOf(IdleHeadPose);
    expect(optionsFor(null)).toEqual({});
    expect(optionsFor(null, { lights: LIGHTS.flat }).lights).toEqual(LIGHTS.flat);
  });

  it("lights a photograph at its own brightness", () => {
    // Lambert: albedo * irradiance / pi. Facing the camera, the hemisphere's
    // mix at a sideways normal plus the key's share come to one.
    const photo = lightsFor("photo");
    const ground = ((photo.groundColor! >> 16) & 255) / 255;
    const facing =
      (photo.hemisphere * (1 + ground)) / 2 / Math.PI + (photo.key * (1.5 / Math.hypot(0.5, 1.2, 1.5))) / Math.PI;
    expect(facing).toBeCloseTo(1, 6);
    expect(lightsFor("render").key).toBeGreaterThan(photo.key);
    expect(lightsFor("flat").key).toBe(0);
  });

  it("turns the head within its range and holds a fixed pose", () => {
    const idle = new IdleHeadPose(() => 0.999); // every draw near +1
    let pose = idle.update(16, 1000, true);
    for (let t = 1016; t < 6000; t += 16) pose = idle.update(16, t, true);
    const yawDeg = (pose.yaw * 180) / Math.PI;
    expect(Math.abs(yawDeg)).toBeLessThanOrEqual(HEAD_POSE_RANGE.yawDeg + 1e-6);
    expect(Math.abs(yawDeg)).toBeGreaterThan(HEAD_POSE_RANGE.yawDeg * 0.8); // it got there
    const fixed = new FixedHeadPose();
    fixed.set(-20, 5);
    expect(fixed.update().yaw).toBeCloseTo((-20 * Math.PI) / 180, 9);
    expect(fixed.update().pitch).toBeCloseTo((5 * Math.PI) / 180, 9);
  });
});
