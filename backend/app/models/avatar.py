from __future__ import annotations

import enum

from sqlalchemy import JSON, Enum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import TimestampedBase


class AvatarStatus(str, enum.Enum):
    pending = "pending"
    processing = "processing"
    ready = "ready"
    failed = "failed"


class AvatarKind(str, enum.Enum):
    photo = "photo"      # 2D photo, rigged with face landmarks
    model3d = "model3d"  # GLB with ARKit/Oculus morph targets


class Avatar(TimestampedBase):
    __tablename__ = "avatars"

    org_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[AvatarStatus] = mapped_column(
        Enum(AvatarStatus), default=AvatarStatus.pending, nullable=False
    )
    kind: Mapped[AvatarKind] = mapped_column(
        Enum(AvatarKind), default=AvatarKind.photo, nullable=False
    )
    content_type: Mapped[str] = mapped_column(String(64), nullable=False)
    # Storage keys (set as the pipeline progresses)
    image_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Set when the background has been removed: points at the photo as it was
    # uploaded, so the cut-out can be undone. Null means image_key IS the
    # original.
    original_image_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Set when the photo has been cropped: points at the photo as it was
    # before. Separate from original_image_key because cropping and background
    # removal are independent — one pointer for both would make undoing a crop
    # silently restore the background too.
    precrop_image_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # The photo exactly as the creation wizard received it (cleaned of its
    # metadata and scaled, nothing else): before framing, before the
    # background came off. Kept so a later edit can always start over from
    # what the owner gave us. Null on avatars made any other way.
    upload_image_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # How the avatar is framed when rendered: "face" crops to the head, "full"
    # shows the whole photo. Stored on the avatar rather than passed per-embed
    # so changing it in the dashboard reaches every site already embedding it.
    framing: Mapped[str] = mapped_column(String(8), default="face", nullable=False)
    rig_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    thumbnail_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Why a READY avatar may still look wrong — face too small, cropped at the
    # frame edge, head turned. Separate from `error`, which means it failed:
    # these are warnings about a working avatar, and conflating them would
    # make "ready with a caveat" indistinguishable from "broken".
    quality_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # A background/body/head layer set exists under .../layers/ — the embed
    # renders those instead of tearing one flat photo. Strictly optional:
    # everything must work when this is False.
    has_layers: Mapped[bool] = mapped_column(default=False, nullable=False)
    # Set means this avatar has a public share page at /s/<token>. A random
    # token rather than the avatar id, so sharing one avatar never exposes an
    # id that appears in authenticated URLs, and revoking is a single UPDATE
    # that instantly kills every copy of the link.
    share_token: Mapped[str | None] = mapped_column(
        String(32), nullable=True, unique=True, index=True
    )
    # "human" (default), "animal" or "cartoon". Selects the viseme table and
    # relaxes the human-geometry checks; nothing else branches on it, and
    # human keeps the behaviour that existed before this field.
    face_type: Mapped[str] = mapped_column(String(16), default="human", nullable=False)
    # The voice this avatar speaks with, as JSON {provider, voice, locale}.
    # Null means the deployment default. A draft/published property like
    # framing: changing it marks the draft dirty, and only publishing makes
    # embedding sites and share links speak with it.
    voice_config: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Which mouth renderer this avatar uses, as JSON {renderer, profile,
    # oral_image_key, oral_rig_key, motion_key, teeth, kit}. Null means the
    # classic drawn mouth. Draft/published like voice; see services.mouth.
    mouth_config: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Draft/published split. `draft_revision` is bumped by every edit a
    # visitor could notice; `published_config` is the JSON snapshot the embed
    # serves. Unpublished changes are simply the two disagreeing — comparing
    # storage keys would not work, because marking the face rewrites rig.json
    # in place under an unchanged key.
    draft_revision: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    published_config: Mapped[str | None] = mapped_column(Text, nullable=True)
    # JSON list of snapshots taken before each edit, oldest first. See
    # app.api.avatars._snapshot.
    edit_history: Mapped[str | None] = mapped_column(Text, nullable=True)
    # {mode, model} when the picture this avatar was built from was made or
    # changed by an AI (the creation wizard's adjust or generate step);
    # null for a photo as its owner gave it. Carried into every publish as
    # the disclosure visitors see ("AI avatar").
    ai_edited: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # The consents (app.models.consent) the creation of this avatar relied
    # on: the depiction statement, and any third-party AI consent. Evidence,
    # read by nothing that renders.
    consent_ids: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # The scene the avatar is shown in: {zoom, pan: {x, y}, background:
    # {kind, color, image_key}} (services.scene). Null for an avatar made
    # before scenes existed, which renders by `framing` alone. Draft/
    # published like framing: changing it marks the draft dirty.
    scene_config: Mapped[dict | None] = mapped_column("scene", JSON, nullable=True)

    @property
    def scene(self) -> dict | None:
        """The owner's view of the scene: never the storage key, only
        whether a background image exists."""
        from app.services.scene import public_view

        return public_view(self.scene_config)

    @property
    def mouth(self) -> dict | None:
        """Public view of the mouth settings — never the storage keys. Its
        `motion_url` is the presigned URL the owner API signed for this
        instance (api.avatars: presigning is async, a property is not), or
        null."""
        from app.services.mouth import public_view

        return public_view(self.mouth_config, getattr(self, "signed_motion_url", None))

    @property
    def render_profile(self) -> str | None:
        """The draft rig's render profile, as the owner API read it off the
        rig for this instance (api.avatars._sign_motion), or null."""
        return getattr(self, "signed_render_profile", None)

    @property
    def voice(self) -> dict | None:
        import json

        try:
            return json.loads(self.voice_config) if self.voice_config else None
        except ValueError:
            return None

    @property
    def unpublished(self) -> bool:
        """Has the draft moved ahead of what visitors are served?

        A property rather than something each endpoint computes: the avatar
        list, the detail page and the publish response must never disagree
        about whether there is something to publish.
        """
        from app.services.publishing import has_unpublished_changes

        return has_unpublished_changes(self)

    @property
    def published(self) -> bool:
        """Is a snapshot being served to visitors?

        What embed and share gate on, and not the same question as whether
        published_at is set: migration 020 gave every avatar live at the
        time a snapshot with no publish date, and those are live.
        """
        from app.services.publishing import config_of

        return config_of(self) is not None

    @property
    def published_at(self) -> str | None:
        from app.services.publishing import config_of

        return (config_of(self) or {}).get("published_at")

    @property
    def undo_label(self) -> str | None:
        """What an undo would reverse, or None when there is nothing to undo.

        Exposed rather than the raw history so the button can name the change
        instead of saying "undo" and hoping the user remembers.
        """
        import json

        try:
            history = json.loads(self.edit_history or "[]")
        except ValueError:
            return None
        return history[-1].get("label") if history else None
