"""A photo on its way to becoming an avatar: the creation wizard's state.

Before creations, an upload became an avatar at once and was rigged from
whatever arrived, or it sat in the staging area as loose keys the browser
kept track of. Neither could be resumed, raced cleanly with background work,
or be confirmed by its owner before going live. A creation is one row per
attempt that holds all of it, and the only way it turns into an avatar is
`finish`, which is the owner's confirmation.

Column notes (the JSON shapes are built and read in services.creations):

- `steps` is every image the wizard produced, keyed by an opaque step id
  ("original", "framed", "cutout"), plus which one is current. Clients only
  ever see the ids, never the storage keys.
- `anchors` is the face mesh the marks are fitted from and the marks
  themselves, bound to the pixel frame they were placed on. A change to that
  frame clears them; a cut-out of it does not, because no pixel moves.
- `job` is the last background job's state transitions only. Progress lives
  in memory (services.jobs): writing it here would put a commit on every tick.
- `revision` is bumped by every change of content. A job stores its result
  only if the revision is still the one it started from.
"""

from __future__ import annotations

import enum

from sqlalchemy import JSON, Enum, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import TimestampedBase


class CreationStatus(str, enum.Enum):
    draft = "draft"
    # Between the owner pressing Finish and the avatar existing. Nothing may
    # change the creation meanwhile; every mutation requires `draft`.
    finishing = "finishing"
    finished = "finished"
    # Idle past its retention; its files are gone and it cannot be resumed.
    expired = "expired"


class Creation(TimestampedBase):
    __tablename__ = "creations"
    # The resume list and the expiry sweep both ask "this org's drafts, by
    # last activity" (the sweep across orgs, by status and age).
    __table_args__ = (Index("ix_creations_org_status_updated", "org_id", "status", "updated_at"),)

    org_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    # human | animal | cartoon ("Animation" in the UI; the stored value stays
    # cartoon, as on avatars). Null until the owner or the analysis names it:
    # with no face detected there is no honest guess between animal and
    # animation, so the wizard asks.
    face_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    status: Mapped[CreationStatus] = mapped_column(
        Enum(CreationStatus), default=CreationStatus.draft, nullable=False
    )
    revision: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    steps: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    analysis: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    anchors: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    job: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Set when finishing starts, so a repeated Finish answers with the same
    # avatar instead of making a second one.
    avatar_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Every consent a step of this creation relied on, in the order used
    # (AI adjust, AI points, generation, and the depiction statement at
    # finish). Copied onto the avatar.
    consent_ids: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # What the AI steps have spent and learned: adjust rounds and point
    # detections used against the per-creation budget, the last adjust
    # round's outcome, and the point finder's answers cached by image hash.
    # Written at job admission (the budget, atomically with the job) and
    # by the job itself; see services.creations.
    ai_usage: Mapped[dict | None] = mapped_column(JSON, nullable=True)
