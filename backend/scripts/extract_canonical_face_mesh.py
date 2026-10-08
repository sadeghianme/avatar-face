"""Write the canonical MediaPipe face mesh beside the head3d builder.

The face landmarker's .task bundle carries MediaPipe's canonical face model
(468 vertices with UVs, 898 triangles — the FACEMESH_TESSELATION topology)
in `geometry_pipeline_metadata_landmarks.binarypb`, a serialised
`face_geometry.GeometryPipelineMetadata`. This mediapipe build ships no
Python bindings for that proto and no `solutions` module, so the message is
read with a minimal protobuf wire decoder here, once, and vendored as JSON
(app/services/head3d/canonical_face_mesh.json): the 3D head's topology must
not depend on a model file that production downloads at image build time.

Run from backend: .venv/bin/python scripts/extract_canonical_face_mesh.py
  [--task models/face_landmarker.task] [--output app/services/head3d/canonical_face_mesh.json]

Provenance: MediaPipe (Google), Apache License 2.0; canonical_face_model.obj.
"""

from __future__ import annotations

import argparse
import json
import struct
import zipfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
DEFAULT_TASK = BACKEND / "models/face_landmarker.task"
DEFAULT_OUTPUT = BACKEND / "app/services/head3d/canonical_face_mesh.json"
METADATA_NAME = "geometry_pipeline_metadata_landmarks.binarypb"

# Field numbers of the two messages we read.
METADATA_CANONICAL_MESH = 1
MESH_VERTEX_BUFFER = 3  # repeated float (unpacked in this bundle)
MESH_INDEX_BUFFER = 4  # repeated uint32 (unpacked in this bundle)
FLOATS_PER_VERTEX = 5  # x y z u v


def _varint(data: bytes, i: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = data[i]
        i += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return result, i


def wire_fields(data: bytes) -> list[tuple[int, int, bytes | int]]:
    """Every (field number, wire type, value) in a protobuf message, in order.
    Packed and unpacked repeated fields both come out as one entry per item
    or per packed blob; the caller knows which it is holding."""
    i = 0
    out: list[tuple[int, int, bytes | int]] = []
    while i < len(data):
        key, i = _varint(data, i)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(data, i)
            out.append((field, wire, value))
        elif wire == 1:
            out.append((field, wire, data[i : i + 8]))
            i += 8
        elif wire == 2:
            length, i = _varint(data, i)
            out.append((field, wire, data[i : i + length]))
            i += length
        elif wire == 5:
            out.append((field, wire, data[i : i + 4]))
            i += 4
        else:
            raise ValueError(f"unsupported wire type {wire}")
    return out


def decode_canonical_mesh(metadata: bytes) -> tuple[list[list[float]], list[list[int]]]:
    """(vertices [[x, y, z, u, v] * 468], triangles [[a, b, c] * 898])."""
    mesh_blobs = [v for f, w, v in wire_fields(metadata) if f == METADATA_CANONICAL_MESH and w == 2]
    if len(mesh_blobs) != 1:
        raise ValueError("no canonical mesh in the metadata")
    floats: list[float] = []
    indices: list[int] = []
    for field, wire, value in wire_fields(mesh_blobs[0]):  # type: ignore[arg-type]
        if field == MESH_VERTEX_BUFFER:
            if wire == 5:
                floats.append(struct.unpack("<f", value)[0])  # type: ignore[arg-type]
            elif wire == 2:  # packed
                blob = value
                floats.extend(struct.unpack(f"<{len(blob) // 4}f", blob))  # type: ignore[arg-type]
        elif field == MESH_INDEX_BUFFER:
            if wire == 0:
                indices.append(int(value))  # type: ignore[arg-type]
            elif wire == 2:  # packed
                blob, j = value, 0
                while j < len(blob):  # type: ignore[arg-type]
                    index, j = _varint(blob, j)  # type: ignore[arg-type]
                    indices.append(index)
    if len(floats) % FLOATS_PER_VERTEX or len(indices) % 3:
        raise ValueError("canonical mesh buffers have unexpected lengths")
    vertices = [floats[k : k + FLOATS_PER_VERTEX] for k in range(0, len(floats), FLOATS_PER_VERTEX)]
    triangles = [indices[k : k + 3] for k in range(0, len(indices), 3)]
    return vertices, triangles


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", type=Path, default=DEFAULT_TASK)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    metadata = zipfile.ZipFile(args.task).read(METADATA_NAME)
    vertices, triangles = decode_canonical_mesh(metadata)
    rounded = [[round(v, 5) for v in vertex] for vertex in vertices]
    args.output.write_text(
        json.dumps(
            {
                "source": "MediaPipe canonical_face_model (Apache-2.0), from face_landmarker.task",
                "vertex_layout": ["x", "y", "z", "u", "v"],
                "vertices": rounded,
                "triangles": triangles,
            },
            separators=(",", ":"),
        )
    )
    print(f"{len(vertices)} vertices, {len(triangles)} triangles -> {args.output}")


if __name__ == "__main__":
    main()
