import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stubImageDecoding } from "../../engine3d/__tests__/three-fakes";
import { VISEME_TO_MORPH } from "../../engine3d/visemes";
import { SYMMETRIC_TO_ARKIT, type Head3DExtras } from "../extras";
import {
  CHUNK_BIN,
  CHUNK_JSON,
  COMPONENT_SIZE,
  GLB_MAGIC,
  TYPE_SIZE,
  readAccessor,
  readGlb,
  type Glb,
  type Gltf,
} from "./glb";

/**
 * The GLB the backend writes (backend/app/services/head3d/gltf.py, the
 * committed synthetic head from backend/scripts/build_head3d_fixture.py),
 * held to the glTF 2.0 container and to what the engine relies on, read
 * byte by byte rather than through three.js: the header and its chunks,
 * every index in range, every accessor inside its buffer view and aligned,
 * the face's topology, and the morph targets' deltas.
 */

const file = readFileSync(new URL("./fixtures/synthetic-head.glb", import.meta.url));
const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
const glb = readGlb(bytes);
const gltf = glb.json;

const meshNamed = (name: string) => gltf.meshes!.find((m) => m.name === name)!;
/** A target's POSITION deltas by its name, from the mesh's targetNames. */
const target = (mesh: string, name: string) => {
  const m = meshNamed(mesh);
  const at = m.extras!.targetNames!.indexOf(name);
  expect(at, `${mesh} ${name}`).toBeGreaterThanOrEqual(0);
  return readAccessor(glb, m.primitives[0].targets![at].POSITION);
};

/** A delta that does not move (either sign of zero). */
const at0 = (delta: number[]) => delta.every((v) => v === 0);

/** A minimal GLB written by the spec's rules, for the reader's own round trip. */
function writeGlb(json: Gltf, bin: Uint8Array): Uint8Array {
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = text.length + pad(text.length);
  const binLength = bin.length + pad(bin.length);
  const out = new Uint8Array(12 + 8 + jsonLength + 8 + binLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  view.setUint32(20 + jsonLength, binLength, true);
  view.setUint32(24 + jsonLength, CHUNK_BIN, true);
  out.set(bin, 28 + jsonLength);
  return out;
}

describe("the GLB reader", () => {
  it("reads back what the spec's layout wrote: header, chunks, packed and strided accessors", () => {
    const floats = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, /* target */ 0, 0.5, 0, 0, 0, 0, 0, 0, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const bin = new Uint8Array(floats.byteLength + indices.byteLength);
    bin.set(new Uint8Array(floats.buffer), 0);
    bin.set(new Uint8Array(indices.buffer), floats.byteLength);
    const json: Gltf = {
      asset: { version: "2.0" },
      buffers: [{ byteLength: bin.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 36 },
        { buffer: 0, byteOffset: 72, byteLength: 6 },
        // Every second float of the base positions: x of each vertex, strided.
        { buffer: 0, byteOffset: 0, byteLength: 36, byteStride: 12 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [0, 0.5, 0] },
        { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
        { bufferView: 3, byteOffset: 4, componentType: 5126, count: 3, type: "SCALAR" },
      ],
    };
    const read = readGlb(writeGlb(json, bin));
    expect(read.version).toBe(2);
    expect(read.chunks.map((c) => c.type)).toEqual([CHUNK_JSON, CHUNK_BIN]);
    expect(read.json).toEqual(json);
    expect(readAccessor(read, 0)).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(readAccessor(read, 1)[0]).toEqual([0, 0.5, 0]);
    expect(readAccessor(read, 2)).toEqual([[0], [1], [2]]);
    expect(readAccessor(read, 3)).toEqual([[0], [0], [1]]); // y of each vertex
    expect(() => readGlb(new Uint8Array(16))).toThrow("not a GLB");
  });
});

describe("the head3d GLB as a glTF 2.0 container", () => {
  it("has a version-2 header whose length is the file's, then a JSON and a BIN chunk, 4-byte aligned", () => {
    expect(glb.version).toBe(2);
    expect(glb.length).toBe(bytes.byteLength);
    expect(glb.length % 4).toBe(0);
    expect(glb.chunks.map((c) => c.type)).toEqual([CHUNK_JSON, CHUNK_BIN]);
    for (const chunk of glb.chunks) {
      expect(chunk.length % 4).toBe(0);
      expect(chunk.offset % 4).toBe(0);
    }
    expect(glb.chunks[1].offset + glb.chunks[1].length).toBe(bytes.byteLength);
    // JSON is padded with spaces, BIN with zeros.
    const text = new TextDecoder().decode(glb.jsonBytes);
    expect(text.trimEnd().endsWith("}")).toBe(true);
    expect(/^ *$/.test(text.slice(text.trimEnd().length))).toBe(true);
    const buffer = gltf.buffers![0];
    expect(gltf.buffers).toHaveLength(1);
    expect(buffer.uri).toBeUndefined(); // the GLB's own BIN chunk
    expect(glb.bin.length - buffer.byteLength).toBeGreaterThanOrEqual(0);
    expect(glb.bin.length - buffer.byteLength).toBeLessThan(4);
    expect(glb.bin.subarray(buffer.byteLength).every((b) => b === 0)).toBe(true);
  });

  it("says glTF 2.0 and requires only the extensions it uses", () => {
    expect(gltf.asset.version).toBe("2.0");
    for (const name of gltf.extensionsRequired ?? []) expect(gltf.extensionsUsed).toContain(name);
    const used = new Set(JSON.stringify(gltf.materials).match(/KHR_\w+/g));
    expect([...used].sort()).toEqual([...(gltf.extensionsUsed ?? [])].sort());
  });

  it("keeps every buffer view inside the buffer and every accessor inside its view, aligned", () => {
    const buffer = gltf.buffers![0];
    for (const [i, view] of gltf.bufferViews!.entries()) {
      expect(view.buffer, `view ${i}`).toBe(0);
      expect((view.byteOffset ?? 0) + view.byteLength, `view ${i}`).toBeLessThanOrEqual(buffer.byteLength);
      if (view.byteStride !== undefined) {
        expect(view.byteStride % 4).toBe(0);
        expect(view.byteStride).toBeGreaterThanOrEqual(4);
        expect(view.byteStride).toBeLessThanOrEqual(252);
      }
    }
    for (const [i, accessor] of gltf.accessors!.entries()) {
      const view = gltf.bufferViews![accessor.bufferView!];
      expect(view, `accessor ${i}`).toBeDefined();
      const size = COMPONENT_SIZE[accessor.componentType];
      const components = TYPE_SIZE[accessor.type];
      expect(size, `accessor ${i} component type`).toBeDefined();
      expect(components, `accessor ${i} type`).toBeDefined();
      expect(accessor.count).toBeGreaterThan(0);
      const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      expect(start % size, `accessor ${i} alignment`).toBe(0);
      const stride = view.byteStride ?? size * components;
      expect(
        (accessor.byteOffset ?? 0) + stride * (accessor.count - 1) + size * components,
        `accessor ${i} length`
      ).toBeLessThanOrEqual(view.byteLength);
      if (view.target === 34962) expect(start % 4, `vertex accessor ${i}`).toBe(0);
    }
  });

  it("gives every POSITION, base or target, the min and max of its data", () => {
    const positions = gltf.meshes!.flatMap((m) =>
      m.primitives.flatMap((p) => [p.attributes.POSITION, ...(p.targets ?? []).map((t) => t.POSITION)])
    );
    expect(positions.length).toBeGreaterThan(50);
    for (const index of positions) {
      const accessor = gltf.accessors![index];
      const data = readAccessor(glb, index);
      for (let c = 0; c < 3; c++) {
        const values = data.map((e) => e[c]);
        expect(accessor.min![c], `accessor ${index}`).toBeCloseTo(Math.min(...values), 6);
        expect(accessor.max![c], `accessor ${index}`).toBeCloseTo(Math.max(...values), 6);
      }
      expect(data.flat().every(Number.isFinite)).toBe(true);
    }
  });

  it("indexes only vertices that exist, in whole triangles, none degenerate", () => {
    for (const mesh of gltf.meshes!) {
      for (const primitive of mesh.primitives) {
        expect(primitive.mode ?? 4, mesh.name).toBe(4);
        const counts = Object.values(primitive.attributes).map((a) => gltf.accessors![a].count);
        expect(new Set(counts).size, `${mesh.name} attribute counts`).toBe(1);
        const accessor = gltf.accessors![primitive.indices!];
        expect(accessor.type).toBe("SCALAR");
        expect([5121, 5123, 5125]).toContain(accessor.componentType);
        const indices = readAccessor(glb, primitive.indices!).map((e) => e[0]);
        expect(indices.length % 3, mesh.name).toBe(0);
        expect(Math.max(...indices), mesh.name).toBeLessThan(counts[0]);
        for (let i = 0; i < indices.length; i += 3) {
          const [a, b, c] = indices.slice(i, i + 3);
          expect(a !== b && b !== c && a !== c, `${mesh.name} triangle ${i / 3}`).toBe(true);
        }
      }
    }
  });

  it("names every morph target once, one name per target, each the size of its mesh", () => {
    for (const mesh of gltf.meshes!) {
      const targets = mesh.primitives[0].targets ?? [];
      const names = mesh.extras?.targetNames ?? [];
      expect(names, mesh.name).toHaveLength(targets.length);
      expect(new Set(names).size).toBe(names.length);
      if (mesh.weights) expect(mesh.weights).toHaveLength(targets.length);
      for (const primitive of mesh.primitives) {
        expect((primitive.targets ?? []).length).toBe(targets.length);
        const vertices = gltf.accessors![primitive.attributes.POSITION].count;
        for (const t of primitive.targets ?? []) {
          for (const [semantic, index] of Object.entries(t)) {
            expect(["POSITION", "NORMAL", "TANGENT"]).toContain(semantic);
            expect(gltf.accessors![index].count).toBe(vertices);
          }
        }
      }
    }
  });

  it("is a tree: every node in range with at most one parent, every one reachable from the scene", () => {
    const nodes = gltf.nodes!;
    const parents = new Map<number, number>();
    for (const [i, node] of nodes.entries()) {
      if (node.mesh !== undefined) expect(node.mesh).toBeLessThan(gltf.meshes!.length);
      for (const child of node.children ?? []) {
        expect(child).toBeLessThan(nodes.length);
        expect(parents.has(child), `node ${child} has two parents`).toBe(false);
        parents.set(child, i);
      }
    }
    const scene = gltf.scenes![gltf.scene ?? 0];
    for (const root of scene.nodes!) expect(parents.has(root), `root ${root} is also a child`).toBe(false);
    const seen = new Set<number>();
    const walk = (i: number, depth: number) => {
      expect(depth).toBeLessThan(nodes.length); // no cycle
      seen.add(i);
      for (const child of nodes[i].children ?? []) walk(child, depth + 1);
    };
    for (const root of scene.nodes!) walk(root, 0);
    expect(seen.size).toBe(nodes.length);
  });

  it("points every material, texture and image at something that exists, the images in their own bytes", () => {
    for (const material of gltf.materials!) {
      const texture = material.pbrMetallicRoughness?.baseColorTexture;
      if (texture) expect(texture.index).toBeLessThan(gltf.textures!.length);
    }
    for (const texture of gltf.textures!) {
      expect(texture.source!).toBeLessThan(gltf.images!.length);
      if (texture.sampler !== undefined) expect(texture.sampler).toBeLessThan(gltf.samplers!.length);
    }
    const signatures: Record<string, number[]> = {
      "image/png": [0x89, 0x50, 0x4e, 0x47],
      "image/jpeg": [0xff, 0xd8, 0xff],
    };
    for (const image of gltf.images!) {
      expect(image.uri).toBeUndefined();
      const view = gltf.bufferViews![image.bufferView!];
      const signature = signatures[image.mimeType!];
      expect(signature, image.mimeType).toBeDefined();
      const start = view.byteOffset ?? 0;
      expect([...glb.bin.subarray(start, start + signature.length)]).toEqual(signature);
    }
  });
});

describe("the head3d GLB's face", () => {
  const face = meshNamed("Face");
  const positions = readAccessor(glb, face.primitives[0].attributes.POSITION);
  const indices = readAccessor(glb, face.primitives[0].indices!).map((e) => e[0]);
  const extras = (gltf.scenes![0].extras as { liveface: Head3DExtras }).liveface;

  it("is MediaPipe's 478 landmarks over its 880 canonical triangles, a surface with no edge shared thrice", () => {
    expect(positions).toHaveLength(478);
    expect(indices).toHaveLength(880 * 3);
    // The ten iris points are landmarks, not surface.
    expect(new Set(indices).size).toBe(468);
    expect(Math.max(...indices)).toBe(467);
    const uses = new Map<string, number>();
    for (let i = 0; i < indices.length; i += 3) {
      const tri = indices.slice(i, i + 3);
      for (let k = 0; k < 3; k++) {
        const [a, b] = [tri[k], tri[(k + 1) % 3]].sort((x, y) => x - y);
        uses.set(`${a},${b}`, (uses.get(`${a},${b}`) ?? 0) + 1);
      }
    }
    expect(Math.max(...uses.values())).toBe(2);
  });

  it("carries the ARKit set the engine falls back on, then the viseme shapes it prefers", () => {
    const names = face.extras!.targetNames!;
    const arkit = Object.values(SYMMETRIC_TO_ARKIT).flat();
    expect(names.slice(0, arkit.length)).toEqual(arkit);
    expect(names.slice(arkit.length, arkit.length + 2)).toEqual(["eyeBlinkLeft", "eyeBlinkRight"]);
    expect(names.slice(arkit.length + 2)).toEqual(Object.values(VISEME_TO_MORPH));
    expect(extras.morphs).toEqual(names);
  });

  it("drops the lower lip and the chin on jawOpen, down and back, and leaves the upper face", () => {
    const jaw = target("Face", "jawOpen");
    expect(jaw[14][1]).toBeLessThan(0); // glTF y is up
    expect(jaw[152][1]).toBeLessThan(0);
    expect(jaw[14][2]).toBeLessThan(0); // and back, toward the skull
    expect(Math.abs(jaw[152][1])).toBeLessThan(Math.abs(jaw[14][1]));
    for (const still of [10, 13, 1, 159, 386]) expect(at0(jaw[still]), `landmark ${still}`).toBe(true);
    // The lower teeth go with the jaw; the upper ones carry no targets.
    expect(meshNamed("TeethLower").extras!.targetNames).toEqual(["jawOpen"]);
    expect(meshNamed("TeethUpper").primitives[0].targets).toBeUndefined();
  });

  it("splits a symmetric target into two halves, one per side, that never overlap", () => {
    const left = target("Face", "eyeBlinkLeft");
    const right = target("Face", "eyeBlinkRight");
    expect(left[386][1]).toBeLessThan(0); // MediaPipe's 386 is the subject's left upper lid
    expect(right[159][1]).toBeLessThan(0);
    expect(at0(left[159])).toBe(true);
    expect(at0(right[386])).toBe(true);
    for (let i = 0; i < 478; i++) {
      const overlap = left[i].some((v) => v !== 0) && right[i].some((v) => v !== 0);
      expect(overlap, `landmark ${i} moves on both sides`).toBe(false);
    }
    const stretchL = target("Face", "mouthStretchLeft");
    const stretchR = target("Face", "mouthStretchRight");
    expect(stretchL[291][0] * stretchR[61][0]).toBeLessThan(0); // the corners part
  });

  it("makes each viseme that needs no side-split weight the sum of its table's targets", () => {
    let checked = 0;
    for (const [viseme, weights] of Object.entries(extras.visemes)) {
      if ((weights.mouthStretch ?? 0) > 0 || (weights.mouthSmile ?? 0) > 0) continue;
      const shape = target("Face", VISEME_TO_MORPH[viseme]);
      const parts = Object.entries(weights)
        .filter(([, w]) => (w ?? 0) > 0)
        .map(
          ([key, w]) => [target("Face", SYMMETRIC_TO_ARKIT[key as keyof typeof SYMMETRIC_TO_ARKIT][0]), w!] as const
        );
      for (let i = 0; i < 478; i++) {
        for (let c = 0; c < 3; c++) {
          const sum = parts.reduce((s, [t, w]) => s + t[i][c] * w, 0);
          expect(shape[i][c]).toBeCloseTo(sum, 6);
        }
      }
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});

describe("the GLB in three.js", () => {
  beforeEach(stubImageDecoding);
  afterEach(() => vi.unstubAllGlobals());

  it("reads the same positions and deltas three.js's loader does", async () => {
    const copy = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    const scene = (await new GLTFLoader().parseAsync(copy, "")).scene;
    const mesh = scene.getObjectByName("Face") as THREE.Mesh;
    const ours = readAccessor(glb as Glb, meshNamed("Face").primitives[0].attributes.POSITION);
    const theirs = mesh.geometry.attributes.position;
    for (const i of [0, 13, 152, 467]) expect([theirs.getX(i), theirs.getY(i), theirs.getZ(i)]).toEqual(ours[i]);
    const jaw = mesh.geometry.morphAttributes.position![mesh.morphTargetDictionary!.jawOpen];
    const ourJaw = target("Face", "jawOpen");
    expect([jaw.getX(14), jaw.getY(14), jaw.getZ(14)]).toEqual(ourJaw[14]);
  });
});
