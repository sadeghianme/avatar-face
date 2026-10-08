"""The plan: the model and the look, the line they make, step 3's modes
and budgets, and the name the wizard proposes."""

from __future__ import annotations

import re
from typing import Final, Literal

from app.models.shapes import AvatarLook, AvatarModel, CreationSteps, Plan, PlanSource
from app.services.creations.steps import plan_of  # noqa: F401  (the plan of a creation's steps)

MODELS = ("human", "animal")
LOOKS = ("realistic", "animation", "cartoon")
SOURCES = ("upload", "generate")
# Where the plan lives in a creation's `steps`.
PLAN: Final = "plan"

# AI runs per creation on step 3 (prepare, retry, each change). Each is one
# paid image call, and the monthly image limit holds them all as well; a
# picture that needs more than this needs a new photo or a new description.
PREPARE_ROUNDS_PER_CREATION = 6
# "Remove this change" (the plain picture again) gives its try back: the
# owner is undoing something, not shopping for a result. It is still a paid
# image call, so it stays metered (the monthly image limit counts it) and
# only this many per creation are free; after that each one counts as a try.
FREE_CLEARS_PER_CREATION = 3
# How long a change or a description may be (the owner's words, quoted).
MAX_WORDS = 300

# Prepare modes (the job's `mode`): the AI in the plan's look from the
# upload; a change of the current AI picture; a new picture from the
# description (a generated creation's Retry); the photo itself, no AI.
AI: Final = "ai"
CHANGE: Final = "change"
GENERATE: Final = "generate"
ORIGINAL: Final = "original"
MODES = (AI, CHANGE, GENERATE, ORIGINAL)
# What a version keeps on its own step item: the anchors found on it, and
# the record of the try that made it (`ai.last_prepare`'s shape).
KEPT_ANCHORS: Final = "anchors"
KEPT_RECORD: Final = "prepare"


def line_for(model: str, look: str) -> Literal["human", "animal", "cartoon"]:
    """The line (face_type) a plan is rigged and rendered on."""
    if look == "realistic":
        return "animal" if model == "animal" else "human"
    return "cartoon"


# The generation style recorded on a step (services.creations' existing
# vocabulary, which the avatar's disclosure and older clients read).
STYLE_OF_LOOK = {"realistic": "photoreal", "animation": "render3d", "cartoon": "illustrated"}


def make_plan(
    model: AvatarModel, look: AvatarLook, source: PlanSource, description: str = ""
) -> Plan:
    return {
        "model": model,
        "look": look,
        "source": source,
        "description": description.strip()[:MAX_WORDS] or None,
    }


def inferred_plan(face_type: str | None, generated: bool) -> Plan:
    """The plan of a creation the old wizard started (no `plan`): read off
    its line, so the new wizard can carry it on."""
    model: AvatarModel = "animal" if face_type == "animal" else "human"
    look: AvatarLook = "cartoon" if face_type == "cartoon" else "realistic"
    return make_plan(model, look, GENERATE if generated else "upload")


# --- The default name --------------------------------------------------------------
#
# The name the wizard proposes is decided ONCE, when the creation is made,
# and kept in its `steps` beside the plan: every screen and the finish say
# the same, whatever tab or reload shows them. (It used to be worked out
# again by each screen from what the tab remembered of the file name, so a
# reload renamed the avatar.)

NAME: Final = "name"
NAME_MAX = 40
# Words a camera or an app puts in a file name: they say nothing about who
# is in the picture, and a name made of them ("Animal realistic raw") is
# worse than the plan's own ("Animal avatar").
TECHNICAL_WORDS = frozenset(
    "img image dsc dscn dscf pxl mvimg photo picture pic screenshot screen shot capture "
    "scan scanned raw copy final export edit edited crop cropped resized untitled "
    "download downloaded received whatsapp signal telegram file new tmp temp test "
    "sample".split()
)
_ARTICLE = re.compile(r"^(a|an|the|un|une|le|la|les|des|l')\s+", re.IGNORECASE)
_SEPARATORS = re.compile(r"[\s_\-.]+")


def _as_name(text: str) -> str:
    """At most NAME_MAX characters, cut at a word boundary when one is near,
    the first letter up."""
    if len(text) > NAME_MAX:
        head = text[: NAME_MAX + 1]
        space = head.rfind(" ")
        text = (head[:space] if space > NAME_MAX / 2 else text[:NAME_MAX]).strip()
    return text[:1].upper() + text[1:]


def technical_file_name(stem: str) -> bool:
    """Is this file name (its extension off) a camera's or an app's rather
    than someone's words? Yes for one of TECHNICAL_WORDS or a digit anywhere
    in it ("IMG_1234", "animal-realistic.raw", "Screenshot 2026-10-05"), for
    a slug (separators and digits are a third or more of it: "a-b-c"), and
    for fewer than two letters ("p", "")."""
    words = [w for w in _SEPARATORS.split(stem) if w]
    if sum(c.isalpha() for c in stem) < 2:
        return True
    if any(w.lower() in TECHNICAL_WORDS or any(c.isdigit() for c in w) for w in words):
        return True
    heavy = sum(1 for c in stem if c in "_-." or c.isdigit())
    return heavy * 3 >= len(stem)


def default_name(*, file_name: str | None = None, description: str | None = None) -> str | None:
    """A first name for the avatar, from what the owner gave (renamed on its
    page in one click): the description's own words ("a cheerful baker with
    flour on her apron" → "Cheerful baker with flour on her apron"), or a
    file name that means something ("maria_headshot.jpg" → "Maria headshot").
    None when neither does (no description; a technical file name): the
    dashboard then names it after the plan ("Human avatar", "Avatar animal")
    in the member's language, which the server does not know."""
    words = _ARTICLE.sub("", re.sub(r"\s+", " ", description or "").strip())
    words = words.rstrip(".,;:!?").strip()
    if words:
        return _as_name(words)
    stem = re.sub(r"\.[^.]+$", "", (file_name or "").strip()).strip()
    if stem and not technical_file_name(stem):
        return _as_name(re.sub(r"\s+", " ", _SEPARATORS.sub(" ", stem)).strip())
    return None


def name_of(steps: CreationSteps | None) -> str | None:
    """The name kept with the creation, or None (the plan's default)."""
    name = (steps or {}).get(NAME)
    return name.strip() if isinstance(name, str) and name.strip() else None
