/**
 * What the 3D engine needs of a browser in Node: a renderer that draws
 * nothing (WebGL is not in Node and no 3D test reads a pixel), a canvas
 * with a size, and a model with morph targets under a Head node.
 */
import * as THREE from "three";
import { vi } from "vitest";

/** A renderer that records its draws; `info` is what stats() reports. */
export function stubRenderer(info = { calls: 0, triangles: 0 }) {
  const render = vi.fn();
  const renderer = {
    setPixelRatio() {},
    setSize() {},
    dispose() {},
    render,
    info: { render: info },
  } as unknown as THREE.WebGLRenderer;
  return { renderer, render };
}

/** A canvas as the engine reads it: a size and a dataset. */
export function stubCanvas(width = 256, height = 256): HTMLCanvasElement {
  return { width, height, dataset: {} } as unknown as HTMLCanvasElement;
}

/** A triangle with morph targets named `morphs`, under a Head node unless
 *  `head` is false; `influence(name)` reads what the engine wrote. */
export function morphModel(morphs: readonly string[], head = true) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0], 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.morphTargetDictionary = Object.fromEntries(morphs.map((name, i) => [name, i]));
  mesh.morphTargetInfluences = morphs.map(() => 0);
  const root = new THREE.Group();
  const headNode = new THREE.Group();
  headNode.name = "Head";
  if (head) {
    headNode.add(mesh);
    root.add(headNode);
  } else {
    root.add(mesh);
  }
  const influence = (name: string) => mesh.morphTargetInfluences![mesh.morphTargetDictionary![name]];
  return { root, head: headNode, mesh, influence };
}
