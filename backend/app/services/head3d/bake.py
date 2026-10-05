"""Run the node bake (embed/src/head3d/bake) for a rig.

The morph targets are the 2D engine's own deformers, recorded by driving
that engine in Node; this module only runs the bundled script and reads
its JSON. The bundle (embed/dist/head3d-bake.mjs) is built by
`npm run build:head3d-bake` in embed/, or here on demand when esbuild is
installed beside it.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
EMBED = REPO / "embed"
BUNDLE = EMBED / "dist/head3d-bake.mjs"
ENTRY = EMBED / "scripts/head3d-bake.ts"
ESBUILD = EMBED / "node_modules/.bin/esbuild"

BAKED_SYMMETRIC = ("jawOpen", "mouthClose", "mouthPucker", "mouthFunnel", "mouthStretch", "mouthSmile", "eyeBlink")


class BakeUnavailable(RuntimeError):
    """Node or the bake bundle is missing."""


def ensure_bundle() -> Path:
    """The bake bundle, built if it is missing or older than its sources."""
    if BUNDLE.exists():
        newest = max(p.stat().st_mtime for p in (EMBED / "src/head3d/bake").glob("*.ts"))
        if BUNDLE.stat().st_mtime >= newest:
            return BUNDLE
    if not ESBUILD.exists():
        raise BakeUnavailable(f"no bake bundle at {BUNDLE} and no esbuild at {ESBUILD}")
    BUNDLE.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [str(ESBUILD), str(ENTRY), "--bundle", "--platform=node", "--format=esm",
         f"--outfile={BUNDLE}", "--log-level=warning"],
        check=True, cwd=str(EMBED),
    )
    return BUNDLE


def validate(bake: dict) -> dict:
    """A bake with every symmetric target and its viseme shapes present,
    478 deltas each."""
    if bake.get("version") != 1 or not isinstance(bake.get("targets"), dict):
        raise ValueError("not a head3d bake")
    for name in BAKED_SYMMETRIC:
        target = bake["targets"].get(name)
        if not target or len(target.get("dx", [])) != 478 or len(target.get("dy", [])) != 478:
            raise ValueError(f"bake is missing target {name}")
    visemes = bake.get("visemes")
    if not isinstance(visemes, dict) or not visemes:
        raise ValueError("bake has no viseme shapes")
    for name, target in visemes.items():
        if len(target.get("dx", [])) != 478 or len(target.get("dy", [])) != 478:
            raise ValueError(f"bake viseme {name} is malformed")
    return bake


def bake_rig(rig: dict, node: str | None = None) -> dict:
    """The bake for a rig (v3 JSON with its viseme table and profile)."""
    node_bin = node or shutil.which("node")
    if not node_bin:
        raise BakeUnavailable("node is not on PATH")
    bundle = ensure_bundle()
    with tempfile.TemporaryDirectory(prefix="head3d-bake-") as tmp:
        rig_path = Path(tmp) / "rig.json"
        out_path = Path(tmp) / "bake.json"
        rig_path.write_text(json.dumps(rig))
        subprocess.run([node_bin, str(bundle), str(rig_path), str(out_path)], check=True,
                       env={**os.environ, "NODE_NO_WARNINGS": "1"}, capture_output=True)
        return validate(json.loads(out_path.read_text()))
