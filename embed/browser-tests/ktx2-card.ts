/**
 * A model the 3D widget shows right only with its KTX2 transcoder: one
 * square card, unlit (KHR_materials_unlit), coloured by a 4x4 KTX2 texture
 * in Basis UASTC (KHR_texture_basisu) that is one solid block of CARD_RGB.
 * Without the transcoder three drops the texture and draws the card white.
 *
 * Written here byte by byte, as no encoder is installed. A solid UASTC
 * block (mode 8) is its colour plus the hints the transcoder builds an
 * ETC1 block from (for a GPU that takes ETC1 or ETC2), checked against
 * the transcoder itself: it decodes to CARD_RGB within 2 for RGBA32,
 * ETC1, BC1, BC7 and ASTC alike.
 */

export const CARD_RGB = [231, 33, 33] as const;

/** A UASTC block, its fields packed least significant bit first. */
function solidUastcBlock([r, g, b]: readonly [number, number, number]): Buffer {
  const five = (v: number) => Math.round((v * 31) / 255);
  const fields: [value: number, bits: number][] = [
    [0b10111, 5], // mode 8: a solid colour
    [r, 8],
    [g, 8],
    [b, 8],
    [255, 8], // alpha
    // The ETC1 hints: differential, intensity table 0, the selector that
    // adds 2, and the colour in 5 bits a channel.
    [1, 1],
    [0, 3],
    [2, 2],
    [five(r), 5],
    [five(g), 5],
    [five(b), 5],
  ];
  const block = Buffer.alloc(16);
  let bit = 0;
  for (const [value, bits] of fields) {
    for (let k = 0; k < bits; k++, bit++) if ((value >> k) & 1) block[bit >> 3] |= 1 << (bit & 7);
  }
  return block;
}

/** A KTX2 container of one 4x4 UASTC block, sRGB, no supercompression. */
function ktx2(block: Buffer): Buffer {
  const dfdOffset = 80 + 24; // header and index, then one level's index
  const dfdLength = 4 + 24 + 16; // total size, the basic block, one sample
  const levelOffset = Math.ceil((dfdOffset + dfdLength) / 16) * 16;
  const file = Buffer.alloc(levelOffset + block.length);
  Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]).copy(file, 0);
  // vkFormat (UNDEFINED: Basis), typeSize, width, height, depth, layers,
  // faces, levels, supercompression (none); then where the DFD is, and no
  // key/values or global data.
  [0, 1, 4, 4, 0, 0, 1, 1, 0, dfdOffset, dfdLength, 0, 0].forEach((v, i) => file.writeUInt32LE(v, 12 + i * 4));
  file.writeBigUInt64LE(0n, 64);
  file.writeBigUInt64LE(0n, 72);
  file.writeBigUInt64LE(BigInt(levelOffset), 80);
  file.writeBigUInt64LE(BigInt(block.length), 88);
  file.writeBigUInt64LE(BigInt(block.length), 96);
  // The data format descriptor: UASTC (166), BT.709 primaries, sRGB, 4x4
  // texels in 16 bytes, one sample (RGB) over all 128 bits.
  let o = dfdOffset;
  file.writeUInt32LE(dfdLength, o);
  file.writeUInt32LE(0, o + 4);
  file.writeUInt16LE(2, o + 8);
  file.writeUInt16LE(24 + 16, o + 10);
  Buffer.from([166, 1, 2, 0, 3, 3, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0]).copy(file, o + 12);
  o += 28;
  file.writeUInt16LE(0, o);
  file.writeUInt8(127, o + 2);
  file.writeUInt8(0, o + 3);
  file.writeUInt32LE(0, o + 8);
  file.writeUInt32LE(0xffffffff, o + 12);
  block.copy(file, levelOffset);
  return file;
}

/** The card, as a binary glTF. */
export function cardGlb(): Buffer {
  const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const texture = ktx2(solidUastcBlock(CARD_RGB));
  const parts = [Buffer.from(positions.buffer), Buffer.from(uvs.buffer), Buffer.from(indices.buffer), texture];
  const views: { buffer: 0; byteOffset: number; byteLength: number }[] = [];
  let offset = 0;
  for (const part of parts) {
    views.push({ buffer: 0, byteOffset: offset, byteLength: part.length });
    offset += Math.ceil(part.length / 4) * 4;
  }
  const bin = Buffer.alloc(offset);
  parts.forEach((part, i) => part.copy(bin, views[i].byteOffset));
  const gltf = {
    asset: { version: "2.0" },
    extensionsUsed: ["KHR_texture_basisu", "KHR_materials_unlit"],
    extensionsRequired: ["KHR_texture_basisu"],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "card" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [
      {
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 },
        extensions: { KHR_materials_unlit: {} },
      },
    ],
    textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
    images: [{ bufferView: 3, mimeType: "image/ktx2" }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC2" },
      { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // glTF
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunk = (type: number, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(body.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, body]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, json), chunk(0x004e4942, bin)]);
}
