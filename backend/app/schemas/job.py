"""The shape of a background job, as the API shows it (services.jobs): a
creation's (api.creations, in CreationOut.job) or an avatar's mouth kit
(api.avatars, POST/GET /avatars/{id}/mouth-kit)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class JobError(BaseModel):
    code: str
    detail: str


class JobCount(BaseModel):
    done: int
    total: int


class JobProgress(BaseModel):
    fraction: float
    # The stage, in the server's words: a finish reports "copying images",
    # "building the rig", "building layers", "making the mouth shapes",
    # "fitting the mouth", "making the teeth", then "publishing", or
    # "publishing with the standard mouth" when a person's own mouth was
    # not made after all (no AI allowed, or it failed); the Mouth panel's
    # kit (step "mouth_kit") "making the mouth shapes", "fitting the mouth",
    # "making the teeth", "saving". A label a client does not know is shown
    # as nothing, never as a wrong stage.
    label: str | None = None
    # How far a counted stage is ("making the mouth shapes": 3 of 7 settled,
    # the six shapes and the teeth photo, made or given up on); null for a
    # stage that is not counted.
    count: JobCount | None = None


class JobOut(BaseModel):
    id: str
    # "mouth_kit": an avatar's mouth shapes and teeth made from its photo
    # (POST /avatars/{id}/mouth-kit); every other step is a creation's.
    step: Literal["ingest", "generate", "adjust", "background", "detect", "finish", "mouth_kit"]
    state: Literal["queued", "running", "done", "failed", "interrupted"]
    error: JobError | None = None
    started_at: str
    # Live, while the job is queued or running in this process.
    progress: JobProgress | None = None
    # POST /retry would run it again.
    retryable: bool = False
