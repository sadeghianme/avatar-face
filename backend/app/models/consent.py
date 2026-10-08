"""A statement someone made before we did something with a photo.

Append-only: a consent is evidence of what a person agreed to, at a given
time, under a given wording. It is never edited (an edit would rewrite what
they said) and never deleted by the app (only with its organization or its
user). Withdrawing is not an UPDATE here; it is the absence of a new one,
because each AI step asks for a consent recorded under the CURRENT wording.

Three scopes (services.consent has the wording and the versions):

- `third_party_ai`: "send this photo to <providers> to edit it or find its
  points". Required for every call that sends pixels out.
- `depiction`: the uploader's statement "I am this person or have their
  permission, and they are 18 or older". Required to finish an avatar made
  from a person's photo, AI or not.
- `generated_face`: "this face was made by AI and is not a real,
  identifiable person", for a face generated from words.

The last two are about one face: `subject_id` is the creation they were
made for, and they count for that creation only.

`ip_hash` is an HMAC of the address with a server secret, never the raw IP:
enough to tell two statements came from the same place, not enough to say
where that was, and useless to anyone without the secret.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, new_id, utcnow


class Consent(Base):
    __tablename__ = "consents"
    # Every lookup is "this person's consent in this org, by id" or "their
    # latest for a scope".
    __table_args__ = (Index("ix_consents_org_user_scope", "org_id", "user_id", "scope"),)

    # Base, not TimestampedBase: an append-only row has no updated_at.
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    org_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    scope: Mapped[str] = mapped_column(String(32), nullable=False)
    # The providers the statement names (["google"]); empty for depiction.
    providers: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    text_version: Mapped[str] = mapped_column(String(32), nullable=False)
    ip_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # The creation a statement about a face was made for; null for
    # third_party_ai. Not a foreign key: the evidence outlives the draft,
    # which is deleted once its avatar is built.
    subject_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
