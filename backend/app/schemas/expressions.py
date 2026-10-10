"""The avatar's AI expression pictures, as the owner's API shows and sets
them (services.expressions, services.expression_kit)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.job import JobError, JobOut

ExpressionName = Literal["happy", "surprised", "concerned", "thinking", "serious"]
Delivery = Literal["now", "batch"]


class ExpressionsChoice(BaseModel):
    """The owner's choice. `ai` true needs `consent_id`: a third_party_ai
    consent naming google, by this member (POST /consents). `delivery`: how
    a publish makes missing pictures; unchanged when omitted."""

    ai: bool
    consent_id: str | None = Field(default=None, min_length=1, max_length=64)
    delivery: Delivery | None = None


class ExpressionsMake(BaseModel):
    # A third_party_ai consent naming google, by this member (POST /consents).
    consent_id: str = Field(min_length=1, max_length=64)


class ExpressionShotOut(BaseModel):
    """One expression of a kit: made, or why not (the animated one plays)."""

    status: Literal["ok", "failed"]
    outcome: str
    reason: JobError | None = None
    smile: bool = Field(
        default=False, description="A parted-lips smile, shown while the avatar is silent."
    )


class ExpressionKitOut(BaseModel):
    id: str
    made_at: str
    source: Literal["panel", "publish", "batch"]
    model: str | None = None
    made: int
    calls: int
    shots: dict[ExpressionName, ExpressionShotOut]


class ExpressionsOut(BaseModel):
    """The DRAFT's expression pictures: the owner's choice, the kit, the
    pictures and manifest presigned for the preview (none for a kit made on
    another picture: `stale`), a batch on its way (`pending`), and the job
    (live while it runs, then how it ended; null when this server ran none
    for it)."""

    ai: bool
    delivery: Delivery = "now"
    kit: ExpressionKitOut | None = None
    stale: bool = False
    pending: bool = False
    manifest_url: str | None = None
    picture_urls: dict[ExpressionName, str] = Field(default_factory=dict)
    job: JobOut | None = None
