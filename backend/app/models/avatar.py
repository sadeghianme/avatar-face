from __future__ import annotations

import enum

from sqlalchemy import Enum, ForeignKey, String, Text
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
    # How the avatar is framed when rendered: "face" crops to the head, "full"
    # shows the whole photo. Stored on the avatar rather than passed per-embed
    # so changing it in the dashboard reaches every site already embedding it.
    framing: Mapped[str] = mapped_column(String(8), default="face", nullable=False)
    rig_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    thumbnail_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # JSON list of snapshots taken before each edit, oldest first. See
    # app.api.avatars._snapshot.
    edit_history: Mapped[str | None] = mapped_column(Text, nullable=True)

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
