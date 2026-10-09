"""What a visitor's engine is served for a published avatar: the public contract.

`PublishedView` is the published snapshot with its files presigned
(services.publishing.published_view). `PublishedAvatarOut` adds what the
avatar is (a share page, GET /public/v1/avatars/{token}); `EmbedAvatarOut`
adds its id (a customer's widget, GET /embed/v1/avatars/{id}). The widget and
the share page generate their types from these (embed/src/api-types.ts,
frontend/src/lib/api-types.ts, both from the committed OpenAPI document).

A widget on a customer's page is the one client that cannot be redeployed
with the server, so this contract only grows. Keys that a snapshot may lack
are left out rather than sent as null (`absent_when_none`), exactly as the
hand-built answers did (tests/test_public_contract.py holds them to it).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, Field
from pydantic.json_schema import SkipJsonSchema

from app.models import Avatar, AvatarKind
from app.schemas.avatar import FaceType

# A key that is either there with a value or not there at all, never null:
# `T | Absent = absent_when_none(...)`. None in Python, left out of the
# answer, and an optional (never nullable) property in the schema, so the
# generated TypeScript says `key?: T`.
Absent = SkipJsonSchema[None]


def absent_when_none(description: str) -> Any:
    """A field left out of the answer when it is None (not sent as null):
    for keys a snapshot from before them does not have."""
    return Field(default=None, exclude_if=lambda value: value is None, description=description)


class PublishedPan(BaseModel):
    """How far the view is moved from the engine's own placement, as
    fractions of the view's size."""

    x: float
    y: float


class PublishedSceneBackground(BaseModel):
    """What is behind a cut-out: nothing, a colour, or a picture."""

    kind: Literal["transparent", "color", "image"]
    color: str | Absent = absent_when_none("`#rrggbb`, for kind `color`.")
    image_url: str | Absent = absent_when_none("The picture, presigned, for kind `image`.")


class PublishedScene(BaseModel):
    """The owner's framing: zoom 1 is the face view, 0 the whole picture,
    above 1 closer in; the pan moves the view, the background sits behind a
    cut-out."""

    zoom: float
    pan: PublishedPan
    background: PublishedSceneBackground


class PublishedVoice(BaseModel):
    """The owner's published voice. A `data-voice` (or provider, locale)
    attribute on the snippet still wins: that is per-site intent."""

    provider: str
    voice: str
    locale: str


class PublishedMouthProfile(BaseModel):
    """The photographic mouth's fit to this face; a value the snapshot does
    not set is the engine's default."""

    teethScale: float | Absent = absent_when_none("Scale of the teeth.")
    teethY: float | Absent = absent_when_none("Vertical offset of the teeth.")
    warmth: float | Absent = absent_when_none("Colour warmth of the mouth's inside.")
    lipProjection: float | Absent = absent_when_none("How far the lips project.")
    jawRange: float | Absent = absent_when_none("How far the jaw opens.")


class PublishedCharacter(BaseModel):
    """How the owner set a character mouth (an animation's or an animal's)."""

    style: Literal["character", "classic"]
    teeth: Literal["upper", "none"]
    tongue: bool
    jaw: float


class PublishedOralUrls(BaseModel):
    """The avatar's own teeth photo and its rig, presigned."""

    image_url: str
    rig_url: str


class PublishedClassicMouth(BaseModel):
    """The classic, drawn mouth, with the owner's character settings."""

    renderer: Literal["classic"]
    character: PublishedCharacter


class PublishedContinuousMouth(BaseModel):
    """The photographic mouth."""

    renderer: Literal["continuous"]
    profile: PublishedMouthProfile
    character: None = Field(description="Always null: character settings are the classic mouth's.")
    oral: PublishedOralUrls | None = Field(
        description="The avatar's own teeth; null for the standard teeth, served beside the motion."
    )
    motion_url: str | None = Field(
        description="The avatar's own performance manifest; null for the bundled Reference motion."
    )


PublishedMouth = Annotated[
    PublishedClassicMouth | PublishedContinuousMouth, Field(discriminator="renderer")
]


class PublishedAiTeeth(BaseModel):
    model: str | None


class PublishedAiMouthShapes(BaseModel):
    model: str | None
    generated: int


class PublishedAiEdited(BaseModel):
    """What an AI made or changed: the picture (`touchup`, `stylise`,
    `regenerate`, `generate`), or only the mouth (`teeth`, `mouth_shapes`)."""

    mode: str
    model: str | None
    teeth: PublishedAiTeeth | Absent = absent_when_none(
        "Present when AI made the teeth photo shown."
    )
    mouth_shapes: PublishedAiMouthShapes | Absent = absent_when_none(
        "Present when AI made the mouth shapes played."
    )


class PublishedDisclosure(BaseModel):
    """What visitors are told about the face."""

    ai_edited: PublishedAiEdited | None = Field(description="Null when no AI made or changed it.")
    line: FaceType


class PublishedView(BaseModel):
    """A published snapshot with its files presigned: what visitors are served,
    whatever the owner's draft is doing."""

    framing: str = Field(description="`face` or `full`: the zoom when there is no scene.")
    face_type: FaceType = Field(
        description="How the head moves: a person's in depth, an animal's or a cartoon's as a layer."
    )
    scene: PublishedScene | None = Field(description="Null for a snapshot from before scenes.")
    voice: PublishedVoice | None
    mouth: PublishedMouth | None = Field(
        description="Null for the classic mouth with nothing of the owner's."
    )
    rig_url: str = Field(description="The rig, presigned; empty when the snapshot has none.")
    thumbnail_url: str = Field(description="The 256 px thumbnail, presigned; may be empty.")
    image_url: str = Field(description="The picture (a GLB for a 3D avatar), presigned.")
    layer_urls: dict[str, str] | None = Field(
        description="`background` (optional), `body` and `head`, presigned, when built."
    )
    disclosure: PublishedDisclosure | Absent = absent_when_none(
        "Absent from snapshots published before disclosures were recorded."
    )


class PublishedAvatarOut(PublishedView):
    """A published avatar, as a share page is served it: nothing addressable."""

    name: str
    kind: AvatarKind
    model_url: str | None = Field(description="For kind `model3d`: the GLB, presigned.")

    @classmethod
    def of(cls, avatar: Avatar, view: PublishedView, **more: Any) -> Self:
        return cls.model_validate(
            {
                **dict(view),
                "name": avatar.name,
                "kind": avatar.kind,
                "model_url": view.image_url if avatar.kind == AvatarKind.model3d else None,
                **more,
            }
        )


class EmbedAvatarOut(PublishedAvatarOut):
    """A published avatar, as a customer's widget is served it."""

    id: str

    @classmethod
    def of(cls, avatar: Avatar, view: PublishedView, **more: Any) -> Self:
        return super().of(avatar, view, id=avatar.id, **more)
