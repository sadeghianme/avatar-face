/**
 * A GLB read as the glTF 2.0 specification lays it out, with nothing of
 * three.js in between: the 12-byte header, the JSON chunk, the BIN chunk,
 * and accessors read straight from the BIN bytes. For tests that hold the
 * backend's writer (backend/app/services/head3d/gltf.py) to the format.
 */

export const GLB_MAGIC = 0x46546c67; // "glTF"
export const CHUNK_JSON = 0x4e4f534a; // "JSON"
export const CHUNK_BIN = 0x004e4942; // "BIN\0"

/** Component types and their byte sizes (glTF 2.0, 3.6.2.2). */
export const COMPONENT_SIZE: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

/** Components per element by accessor type. */
export const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}
export interface BufferView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }
export interface Primitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: Record<string, number>[];
}
export interface Mesh { name?: string; primitives: Primitive[]; weights?: number[]; extras?: { targetNames?: string[] } }
export interface Node { name?: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[] }

/** The JSON chunk, as far as these tests read it. */
export interface Gltf {
  asset: { version: string; minVersion?: string; generator?: string };
  scene?: number;
  scenes?: { name?: string; nodes?: number[]; extras?: Record<string, unknown> }[];
  nodes?: Node[];
  meshes?: Mesh[];
  materials?: { name?: string; pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }[];
  accessors?: Accessor[];
  bufferViews?: BufferView[];
  buffers?: { byteLength: number; uri?: string }[];
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
  textures?: { sampler?: number; source?: number }[];
  samplers?: object[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

export interface Chunk { type: number; offset: number; length: number }

export interface Glb {
  version: number;
  /** The total length the header declares. */
  length: number;
  chunks: Chunk[];
  json: Gltf;
  /** The JSON chunk's raw bytes, padding included. */
  jsonBytes: Uint8Array;
  /** The BIN chunk, padding included. */
  bin: Uint8Array;
}

/** Split a GLB into its header and chunks; throws on a malformed container. */
export function readGlb(bytes: Uint8Array): Glb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || view.getUint32(0, true) !== GLB_MAGIC) throw new Error("not a GLB");
  const version = view.getUint32(4, true);
  const length = view.getUint32(8, true);
  const chunks: Chunk[] = [];
  for (let at = 12; at < Math.min(length, bytes.byteLength); ) {
    const chunkLength = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    chunks.push({ type, offset: at + 8, length: chunkLength });
    at += 8 + chunkLength;
  }
  const [jsonChunk, binChunk] = chunks;
  if (!jsonChunk || jsonChunk.type !== CHUNK_JSON) throw new Error("the first chunk is not JSON");
  const jsonBytes = bytes.subarray(jsonChunk.offset, jsonChunk.offset + jsonChunk.length);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes)) as Gltf;
  const bin = binChunk ? bytes.subarray(binChunk.offset, binChunk.offset + binChunk.length) : new Uint8Array();
  return { version, length, chunks, json, jsonBytes, bin };
}

/** An accessor's elements, read from the BIN chunk (tightly packed or strided). */
export function readAccessor(glb: Glb, index: number): number[][] {
  const accessor = glb.json.accessors![index];
  const view = glb.json.bufferViews![accessor.bufferView!];
  const size = COMPONENT_SIZE[accessor.componentType];
  const components = TYPE_SIZE[accessor.type];
  const stride = view.byteStride ?? size * components;
  const data = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out: number[][] = [];
  for (let i = 0; i < accessor.count; i++) {
    const element: number[] = [];
    for (let c = 0; c < components; c++) {
      const at = base + i * stride + c * size;
      switch (accessor.componentType) {
        case 5120: element.push(data.getInt8(at)); break;
        case 5121: element.push(data.getUint8(at)); break;
        case 5122: element.push(data.getInt16(at, true)); break;
        case 5123: element.push(data.getUint16(at, true)); break;
        case 5125: element.push(data.getUint32(at, true)); break;
        default: element.push(data.getFloat32(at, true));
      }
    }
    out.push(element);
  }
  return out;
}
