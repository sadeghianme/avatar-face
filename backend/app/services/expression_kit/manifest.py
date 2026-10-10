"""4. The manifest the engine's expression pictures load, and a stored one
moved onto the face's points as they are now (rebase).

    {
      "version": 1, "kind": "liveface-expressions", "kit": "<id>",
      "image_size": [w, h],          the avatar's picture, as rigged
      "base": [[x, y] * 478],        the confirmed points the targets were made on
      "expressions": {
        "happy": {
          "size": [w, h],            the expression picture's own size
          "uv": [[x, y] * 478],      its landmarks, in its own pixels
          "targets": [[x, y] * 478], where they go on the avatar's picture
          "smile": true              a parted-lips smile (the pause smile)
        }, ...
      },
      "recipe": {"kit_version", "prompts_version", "model"}
    }

The engine morphs its mesh toward `targets` (picture pixels, as the rig's
points) by the expression's weight under its mask, and draws the
expression picture there sampled at `uv`: the picture's own features land
on the moved mesh, so nothing ghosts. Pixel coordinates to one decimal: a
tenth of a picture pixel is under anything the engine can show.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np

from app.services.expression_kit.constants import (
    EXPRESSIONS,
    KIT_VERSION,
    MANIFEST_KIND,
    MANIFEST_VERSION,
    PROMPTS_VERSION,
)
from app.services.performance_kit.constants import KIT_ID
from app.services.performance_kit.requests import checked_points

DECIMALS = 1
# A picture moved under the same face (a crop, a crop undone) translates
# every point alike; points re-marked on the same picture move a few. A
# rebase that would move the base by more than this, in face widths, is
# another face, and the kit cannot follow it.
MAX_REBASE_SHIFT = 0.5


@dataclass(frozen=True)
class ExpressionEntry:
    """One expression for the manifest."""

    size: tuple[int, int]
    uv: np.ndarray
    targets: np.ndarray
    smile: bool = False


def _rounded(points: np.ndarray) -> list:
    return np.asarray(points, dtype=np.float64).round(DECIMALS).tolist()


def build_manifest(
    base_points: np.ndarray,
    image_size: tuple[int, int],
    entries: Mapping[str, ExpressionEntry],
    *,
    kit_id: str,
    model: str | None,
) -> dict:
    """The manifest for the expressions made (`entries`, in EXPRESSIONS
    order; the others are not in it: the engine plays them animated)."""
    if not KIT_ID.fullmatch(kit_id):
        raise ValueError("the kit id must be 1-64 ASCII letters, digits, '_' or '-'")
    base = checked_points(base_points)
    expressions = {}
    for name in EXPRESSIONS:
        entry = entries.get(name)
        if entry is None:
            continue
        expressions[name] = {
            "size": [int(entry.size[0]), int(entry.size[1])],
            "uv": _rounded(checked_points(entry.uv)),
            "targets": _rounded(checked_points(entry.targets)),
            "smile": bool(entry.smile),
        }
    return {
        "version": MANIFEST_VERSION,
        "kind": MANIFEST_KIND,
        "kit": kit_id,
        "image_size": [int(image_size[0]), int(image_size[1])],
        "base": _rounded(base),
        "expressions": expressions,
        "recipe": {
            "kit_version": KIT_VERSION,
            "prompts_version": PROMPTS_VERSION,
            "model": model,
        },
    }


def is_expressions_manifest(manifest: object) -> bool:
    """Is `manifest` one build_manifest made (the shape the embed accepts)?"""
    if not isinstance(manifest, dict):
        return False
    if manifest.get("version") != MANIFEST_VERSION or manifest.get("kind") != MANIFEST_KIND:
        return False
    try:
        checked_points(manifest["base"])
        expressions = manifest["expressions"]
        if not isinstance(expressions, dict) or not set(expressions) <= set(EXPRESSIONS):
            return False
        for entry in expressions.values():
            checked_points(entry["uv"])
            checked_points(entry["targets"])
            width, height = entry["size"]
            if width <= 0 or height <= 0:
                return False
    except (KeyError, TypeError, ValueError):
        return False
    return True


def rebase(manifest: dict, points, image_size=None) -> dict:
    """`manifest` moved onto the face's `points` (and the picture's
    `image_size`, when the picture changed size: a crop, its reset): every
    expression keeps what it moved (its targets less the old base), added
    to the new points. The pictures and their `uv` are unchanged: they are
    their own. Raises ValueError for a manifest that is not one, or points
    of another face (MAX_REBASE_SHIFT)."""
    if not is_expressions_manifest(manifest):
        raise ValueError("not an expressions manifest")
    old = np.asarray(manifest["base"], dtype=np.float64)
    new = checked_points(points)
    face = float(np.linalg.norm(new[454] - new[234]))
    # How far any point moved once the picture's own translation is taken out.
    moved = np.linalg.norm((new - new.mean(axis=0)) - (old - old.mean(axis=0)), axis=1).max()
    if float(moved) / max(face, 1.0) > MAX_REBASE_SHIFT:
        raise ValueError("the points are another face's")
    rebased = dict(manifest)
    rebased["base"] = _rounded(new)
    if image_size is not None:
        rebased["image_size"] = [int(image_size[0]), int(image_size[1])]
    rebased["expressions"] = {
        name: {
            **entry,
            "targets": _rounded(np.asarray(entry["targets"], dtype=np.float64) - old + new),
        }
        for name, entry in manifest["expressions"].items()
    }
    return rebased
