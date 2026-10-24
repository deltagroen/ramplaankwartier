"""Minimale glTF 2.0 binary (GLB) schrijver op basis van numpy-arrays.

Ondersteunt per mesh: POSITION, NORMAL, TEXCOORD_0, COLOR_0 (uint8 genormaliseerd),
eigen attributen (bijv. _BID) en een PBR-materiaal met optionele externe textuur.
"""
import json
import struct
import numpy as np

_COMP = {np.dtype(np.float32): 5126, np.dtype(np.uint32): 5125, np.dtype(np.uint16): 5123, np.dtype(np.uint8): 5121}
_TYPES = {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4"}


class GLBWriter:
    def __init__(self):
        self._chunks = []
        self._offset = 0
        self.bufferViews = []
        self.accessors = []
        self.meshes = []
        self.nodes = []
        self.materials = []
        self.images = []
        self.textures = []
        self.extras = {}
        self.extensions_used = set()

    def _view(self, data: bytes, target=None):
        pad = (-len(data)) % 4
        self._chunks.append(data + b"\0" * pad)
        view = {"buffer": 0, "byteOffset": self._offset, "byteLength": len(data)}
        if target:
            view["target"] = target
        self._offset += len(data) + pad
        self.bufferViews.append(view)
        return len(self.bufferViews) - 1

    def _accessor(self, arr, target, normalized=False, minmax=False):
        arr = np.ascontiguousarray(arr)
        if arr.ndim == 1:
            arr = arr[:, None]
        n, k = arr.shape
        acc = {"bufferView": self._view(arr.tobytes(), target), "componentType": _COMP[arr.dtype],
               "count": int(n), "type": _TYPES[k]}
        if normalized:
            acc["normalized"] = True
        if minmax:
            acc["min"] = [float(v) for v in arr.min(axis=0)]
            acc["max"] = [float(v) for v in arr.max(axis=0)]
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def add_material(self, name, color=(1.0, 1.0, 1.0, 1.0), texture_uri=None, metallic=0.0, roughness=1.0,
                     alpha_mode="OPAQUE", double_sided=False):
        mat = {"name": name,
               "pbrMetallicRoughness": {"baseColorFactor": [float(c) for c in color],
                                        "metallicFactor": float(metallic), "roughnessFactor": float(roughness)},
               "alphaMode": alpha_mode, "doubleSided": bool(double_sided)}
        if texture_uri:
            self.images.append({"uri": texture_uri})
            if texture_uri.lower().endswith(".webp"):
                self.textures.append({"sampler": 0, "extensions": {"EXT_texture_webp": {"source": len(self.images) - 1}}})
                self.extensions_used.add("EXT_texture_webp")
            else:
                self.textures.append({"source": len(self.images) - 1, "sampler": 0})
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": len(self.textures) - 1}
        self.materials.append(mat)
        return len(self.materials) - 1

    def add_mesh(self, name, positions, indices, material, normals=None, uvs=None, colors=None, custom=None, extras=None):
        attrs = {"POSITION": self._accessor(np.asarray(positions, dtype=np.float32), 34962, minmax=True)}
        if normals is not None:
            attrs["NORMAL"] = self._accessor(np.asarray(normals, dtype=np.float32), 34962)
        if uvs is not None:
            attrs["TEXCOORD_0"] = self._accessor(np.asarray(uvs, dtype=np.float32), 34962)
        if colors is not None:
            colors = np.asarray(colors)
            if colors.dtype != np.uint8:
                # invoer is sRGB (zoals je de kleur ziet); glTF verwacht lineaire hoekpuntkleuren
                c = np.clip(colors.astype(np.float64), 0, 1)
                lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
                colors = np.clip(lin * 255.0 + 0.5, 0, 255).astype(np.uint8)
            attrs["COLOR_0"] = self._accessor(colors, 34962, normalized=True)
        for key, arr in (custom or {}).items():
            attrs[key] = self._accessor(np.asarray(arr, dtype=np.float32), 34962)
        idx = self._accessor(np.asarray(indices, dtype=np.uint32).ravel(), 34963)
        mesh = {"name": name, "primitives": [{"attributes": attrs, "indices": idx, "material": material, "mode": 4}]}
        if extras:
            mesh["extras"] = extras
        self.meshes.append(mesh)
        self.nodes.append({"name": name, "mesh": len(self.meshes) - 1})
        return len(self.meshes) - 1

    def write(self, path):
        gltf = {"asset": {"version": "2.0", "generator": "ramplaankwartier3d"}, "scene": 0,
                "scenes": [{"nodes": list(range(len(self.nodes)))}], "nodes": self.nodes, "meshes": self.meshes,
                "accessors": self.accessors, "bufferViews": self.bufferViews, "buffers": [{"byteLength": self._offset}]}
        if self.materials:
            gltf["materials"] = self.materials
        if self.images:
            gltf["images"] = self.images
            gltf["textures"] = self.textures
            gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
        if self.extras:
            gltf["extras"] = self.extras
        if self.extensions_used:
            gltf["extensionsUsed"] = sorted(self.extensions_used)
            gltf["extensionsRequired"] = sorted(self.extensions_used)
        js = json.dumps(gltf, separators=(",", ":")).encode()
        js += b" " * ((-len(js)) % 4)
        binary = b"".join(self._chunks)
        total = 12 + 8 + len(js) + 8 + len(binary)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))
            f.write(struct.pack("<II", len(js), 0x4E4F534A))
            f.write(js)
            f.write(struct.pack("<II", len(binary), 0x004E4942))
            f.write(binary)
        return total
