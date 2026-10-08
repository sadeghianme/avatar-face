"""A GLB writer, as much of glTF 2.0 as a head needs.

Meshes with positions, normals, UVs and indices; morph targets (POSITION
deltas, named through `extras.targetNames`, which three.js reads into
`morphTargetDictionary`); PBR materials with an embedded base-colour texture
(PNG/JPEG, or WebP through EXT_texture_webp); unlit materials
(KHR_materials_unlit); a node hierarchy with translations and extras. The
whole file is one binary buffer. Nothing else: no animation, no skins.

numpy only. Written rather than installed (pygltflib/trimesh are not in the
venv) so the builder has no dependency the server image lacks.
"""

from __future__ import annotations

import json
import struct

import numpy as np

GLB_MAGIC = 0x46546C67
GLB_VERSION = 2
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

FLOAT = 5126
UNSIGNED_INT = 5125
UNSIGNED_SHORT = 5123
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
TRIANGLES = 4


def _pad(data: bytes, align: int = 4, fill: bytes = b"\x00") -> bytes:
    remainder = len(data) % align
    return data if remainder == 0 else data + fill * (align - remainder)


class GlbBuilder:
    """Accumulates one glTF document and its binary buffer."""

    def __init__(self, generator: str = "liveface head3d") -> None:
        self.generator = generator
        self.buffer = bytearray()
        self.buffer_views: list[dict] = []
        self.accessors: list[dict] = []
        self.images: list[dict] = []
        self.textures: list[dict] = []
        self.samplers: list[dict] = [
            {"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}
        ]
        self.materials: list[dict] = []
        self.meshes: list[dict] = []
        self.nodes: list[dict] = []
        self.extensions_used: set[str] = set()

    # --- buffers -------------------------------------------------------------

    def _view(self, data: bytes, target: int | None = None) -> int:
        offset = len(self.buffer)
        self.buffer.extend(_pad(data))
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        self.buffer_views.append(view)
        return len(self.buffer_views) - 1

    def _accessor(
        self, array: np.ndarray, component: int, kind: str, target: int | None, minmax: bool = False
    ) -> int:
        view = self._view(array.tobytes(), target)
        accessor: dict = {
            "bufferView": view,
            "componentType": component,
            "count": int(array.shape[0]),
            "type": kind,
        }
        if minmax:
            flat = array.reshape(array.shape[0], -1)
            accessor["min"] = [float(v) for v in flat.min(axis=0)]
            accessor["max"] = [float(v) for v in flat.max(axis=0)]
        self.accessors.append(accessor)
        return len(self.accessors) - 1

    # --- images and materials ---------------------------------------------------

    def add_image(self, data: bytes, mime: str) -> int:
        """An embedded image; returns its index."""
        if mime not in ("image/png", "image/jpeg", "image/webp"):
            raise ValueError(f"unsupported image type {mime}")
        self.images.append({"bufferView": self._view(data), "mimeType": mime})
        return len(self.images) - 1

    def add_texture(self, image: int) -> int:
        """A texture over an image. A WebP image goes through
        EXT_texture_webp (no fallback: every target browser decodes WebP)."""
        texture: dict = {"sampler": 0}
        if self.images[image]["mimeType"] == "image/webp":
            texture["extensions"] = {"EXT_texture_webp": {"source": image}}
            self.extensions_used.add("EXT_texture_webp")
        else:
            texture["source"] = image
        self.textures.append(texture)
        return len(self.textures) - 1

    def add_material(
        self,
        name: str,
        texture: int | None = None,
        colour: tuple[float, float, float, float] = (1, 1, 1, 1),
        alpha_mode: str = "OPAQUE",
        double_sided: bool = False,
        unlit: bool = False,
        roughness: float = 1.0,
    ) -> int:
        pbr: dict = {
            "baseColorFactor": [float(c) for c in colour],
            "metallicFactor": 0.0,
            "roughnessFactor": float(roughness),
        }
        if texture is not None:
            pbr["baseColorTexture"] = {"index": texture}
        material: dict = {
            "name": name,
            "pbrMetallicRoughness": pbr,
            "alphaMode": alpha_mode,
            "doubleSided": double_sided,
        }
        if unlit:
            material["extensions"] = {"KHR_materials_unlit": {}}
            self.extensions_used.add("KHR_materials_unlit")
        self.materials.append(material)
        return len(self.materials) - 1

    # --- meshes and nodes ---------------------------------------------------------

    def add_mesh(
        self,
        name: str,
        positions: np.ndarray,
        uvs: np.ndarray,
        triangles: np.ndarray,
        material: int,
        normals: np.ndarray | None = None,
        targets: list[tuple[str, np.ndarray]] | None = None,
    ) -> int:
        """One primitive of triangles; `targets` are (ARKit name, (n, 3)
        position deltas). Returns the mesh index."""
        positions = np.ascontiguousarray(positions, dtype=np.float32)
        uvs = np.ascontiguousarray(uvs, dtype=np.float32)
        n = positions.shape[0]
        if positions.shape != (n, 3) or uvs.shape != (n, 2):
            raise ValueError("positions must be (n, 3) and uvs (n, 2)")
        indices = np.ascontiguousarray(triangles, dtype=np.uint32).reshape(-1)
        if indices.size and int(indices.max()) >= n:
            raise ValueError("triangle index out of range")
        attributes = {
            "POSITION": self._accessor(positions, FLOAT, "VEC3", ARRAY_BUFFER, minmax=True),
            "TEXCOORD_0": self._accessor(uvs, FLOAT, "VEC2", ARRAY_BUFFER),
        }
        if normals is not None:
            normals = np.ascontiguousarray(normals, dtype=np.float32)
            if normals.shape != (n, 3):
                raise ValueError("normals must be (n, 3)")
            attributes["NORMAL"] = self._accessor(normals, FLOAT, "VEC3", ARRAY_BUFFER)
        if n <= 65535:
            index_accessor = self._accessor(
                indices.astype(np.uint16), UNSIGNED_SHORT, "SCALAR", ELEMENT_ARRAY_BUFFER
            )
        else:
            index_accessor = self._accessor(indices, UNSIGNED_INT, "SCALAR", ELEMENT_ARRAY_BUFFER)
        primitive: dict = {
            "attributes": attributes,
            "indices": index_accessor,
            "material": material,
            "mode": TRIANGLES,
        }
        mesh: dict = {"name": name, "primitives": [primitive]}
        if targets:
            primitive["targets"] = []
            names = []
            for target_name, delta in targets:
                delta = np.ascontiguousarray(delta, dtype=np.float32)
                if delta.shape != (n, 3):
                    raise ValueError(f"target {target_name} must be (n, 3)")
                primitive["targets"].append(
                    {"POSITION": self._accessor(delta, FLOAT, "VEC3", ARRAY_BUFFER, minmax=True)}
                )
                names.append(target_name)
            mesh["weights"] = [0.0] * len(names)
            mesh["extras"] = {"targetNames": names}
        self.meshes.append(mesh)
        return len(self.meshes) - 1

    def add_node(
        self,
        name: str,
        mesh: int | None = None,
        children: list[int] | None = None,
        translation: tuple[float, float, float] | None = None,
        extras: dict | None = None,
    ) -> int:
        node: dict = {"name": name}
        if mesh is not None:
            node["mesh"] = mesh
        if children:
            node["children"] = list(children)
        if translation is not None:
            node["translation"] = [float(v) for v in translation]
        if extras:
            node["extras"] = extras
        self.nodes.append(node)
        return len(self.nodes) - 1

    # --- the file -------------------------------------------------------------------

    def document(
        self, scene_nodes: list[int], scene_name: str, scene_extras: dict | None = None
    ) -> dict:
        scene: dict = {"name": scene_name, "nodes": list(scene_nodes)}
        if scene_extras:
            scene["extras"] = scene_extras
        doc: dict = {
            "asset": {"version": "2.0", "generator": self.generator},
            "scene": 0,
            "scenes": [scene],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": self.materials,
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [{"byteLength": len(self.buffer)}],
        }
        if self.images:
            doc["images"] = self.images
            doc["textures"] = self.textures
            doc["samplers"] = self.samplers
        if self.extensions_used:
            doc["extensionsUsed"] = sorted(self.extensions_used)
            doc["extensionsRequired"] = sorted(
                e for e in self.extensions_used if e == "EXT_texture_webp"
            )
        return doc

    def build(
        self, scene_nodes: list[int], scene_name: str = "Liveface", scene_extras: dict | None = None
    ) -> bytes:
        doc = self.document(scene_nodes, scene_name, scene_extras)
        json_chunk = _pad(json.dumps(doc, separators=(",", ":")).encode("utf-8"), fill=b" ")
        bin_chunk = _pad(bytes(self.buffer))
        total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
        return b"".join(
            (
                struct.pack("<III", GLB_MAGIC, GLB_VERSION, total),
                struct.pack("<II", len(json_chunk), CHUNK_JSON),
                json_chunk,
                struct.pack("<II", len(bin_chunk), CHUNK_BIN),
                bin_chunk,
            )
        )


def read_glb(data: bytes) -> tuple[dict, bytes]:
    """(json document, binary chunk) of a GLB; for tests and reports."""
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != GLB_VERSION or length != len(data):
        raise ValueError("not a GLB")
    offset = 12
    doc: dict | None = None
    binary = b""
    while offset < length:
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8 : offset + 8 + chunk_length]
        if chunk_type == CHUNK_JSON:
            doc = json.loads(chunk.decode("utf-8"))
        elif chunk_type == CHUNK_BIN:
            binary = bytes(chunk)
        offset += 8 + chunk_length
    if doc is None:
        raise ValueError("GLB without a JSON chunk")
    return doc, binary


def read_accessor(doc: dict, binary: bytes, index: int) -> np.ndarray:
    """An accessor's data as a numpy array (count, components)."""
    accessor = doc["accessors"][index]
    view = doc["bufferViews"][accessor["bufferView"]]
    dtype = {FLOAT: np.float32, UNSIGNED_INT: np.uint32, UNSIGNED_SHORT: np.uint16}[
        accessor["componentType"]
    ]
    components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    start = view.get("byteOffset", 0)
    count = accessor["count"] * components
    array = np.frombuffer(binary, dtype=dtype, count=count, offset=start)
    return array.reshape(accessor["count"], components)
