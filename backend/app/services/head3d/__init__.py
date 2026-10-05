"""head3d: a textured, rigged 3D head from one picture and its landmarks.

SPIKE (decision-grade prototype) for a SitePal "PhotoFace"-style avatar line:
MediaPipe's 478 landmarks with their z give a face relief on the canonical
face-mesh topology, the picture is its texture, a procedural cranium and neck
sit behind it, the cut-out's hair and ears ride on a card, a simple mouth
interior sits behind the lips, and the ARKit-named morph targets are BAKED
from the 2D engine's own deformers (embed/src/head3d/bake), so the head moves
exactly like the 2D line and the existing three.js engine drives it with the
same lip-sync controller.

CPU only, numpy + Pillow; the GLB is written by this package's own writer
(gltf.py). Nothing here touches the 2D engine or the existing services; the
landmarker is reused read-only (services.landmarks exposes x, y and z).

Modules: topology (the shared mesh), geometry (pure numpy: depth, skull,
neck, cards, mouth interior, morph rules), texture (what the picture gives
each surface), gltf (the GLB writer), bake (runs the node bake), build (the
assembly). CLI: backend/scripts/build_head3d.py.
"""
