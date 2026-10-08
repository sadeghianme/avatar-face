"""Consents over the API: what the dashboard asks for, and recording it.

The dashboard shows the wording (translated, in the frontend) and sends the
version it showed; the server refuses a version it does not know, so what
is stored always names a text that was really on screen. See
services.consent for the scopes and what each one unlocks.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.api.deps import DB, OrgMember, client_address
from app.services import consent as svc
from app.services.ai_models import PROVIDER

router = APIRouter(prefix="/orgs/{org_id}/consents", tags=["consents"])


class ConsentCreate(BaseModel):
    scope: Literal["third_party_ai", "depiction", "generated_face"]
    text_version: str = Field(min_length=1, max_length=32)
    # third_party_ai only; omitted means ["google"], the only provider today.
    providers: list[str] | None = Field(default=None, max_length=4)
    # depiction and generated_face: the creation whose face the statement is
    # about. Required for them; it is accepted for that creation only.
    creation_id: str | None = Field(default=None, max_length=32)


class ConsentOut(BaseModel):
    id: str
    scope: str
    providers: list[str]
    text_version: str
    creation_id: str | None = None
    created_at: datetime


class ScopeTerms(BaseModel):
    text_version: str
    providers: list[str] = Field(default_factory=list)


class ConsentTerms(BaseModel):
    third_party_ai: ScopeTerms
    depiction: ScopeTerms
    generated_face: ScopeTerms
    # False when an owner or admin has turned third-party AI off: the
    # dashboard hides the AI steps instead of asking for a consent the
    # server would refuse.
    third_party_ai_enabled: bool


@router.get("/terms", response_model=ConsentTerms)
async def consent_terms(ctx: OrgMember) -> ConsentTerms:
    """The wording versions in force, the providers named, and whether this
    organization allows third-party AI at all."""
    return ConsentTerms(
        third_party_ai=ScopeTerms(
            text_version=svc.TEXT_VERSIONS[svc.THIRD_PARTY_AI], providers=[PROVIDER]
        ),
        depiction=ScopeTerms(text_version=svc.TEXT_VERSIONS[svc.DEPICTION]),
        generated_face=ScopeTerms(text_version=svc.TEXT_VERSIONS[svc.GENERATED_FACE]),
        third_party_ai_enabled=ctx.org.third_party_ai_enabled,
    )


class MyConsentOut(BaseModel):
    scope: str
    # The wording version in force: what a new consent must be given under.
    text_version: str
    # The caller's latest consent under that version, to pass to the step
    # it is for; null means ask (never asked, or the wording changed).
    consent_id: str | None = None
    created_at: datetime | None = None
    # True only when consent_id is null because the wording changed: the
    # member did agree to an earlier version. Lets the dashboard say why it
    # asks again. False for a member who never agreed, or who has agreed now.
    stale: bool = False


@router.get("/mine", response_model=MyConsentOut)
async def my_consent(ctx: OrgMember, db: DB, scope: Literal["third_party_ai"]) -> MyConsentOut:
    """The signed-in member's latest consent for `scope` under the current
    wording, or null: the dashboard asks once per person and wording, not
    per photo. A step still checks it (and the organization's switch).

    Only the third-party AI consent is remembered: a statement about a face
    (depiction, generated_face) is about one creation and asked for each."""
    consent = await svc.latest(db, ctx.org, ctx.membership.user_id, scope)
    return MyConsentOut(
        scope=scope,
        text_version=svc.TEXT_VERSIONS[scope],
        consent_id=consent.id if consent else None,
        created_at=consent.created_at if consent else None,
        stale=consent is None
        and await svc.agreed_before(db, ctx.org, ctx.membership.user_id, scope),
    )


@router.post("", response_model=ConsentOut, status_code=201)
async def give_consent(body: ConsentCreate, ctx: OrgMember, db: DB, request: Request) -> ConsentOut:
    """Record a statement by the signed-in member. Pass the returned id to
    the step it is for (adjust, detect with AI, generate, finish).

    A statement about a face names its creation (`creation_id`, one of this
    organization's; 404 otherwise). The address is the client's, through the
    proxies this server trusts (deps.client_address), and only its keyed
    hash is stored."""
    subject_id = None
    if body.scope in svc.SUBJECT_SCOPES and body.creation_id:
        subject_id = await svc.creation_subject(db, ctx.org, body.creation_id)
    consent = await svc.record(
        db,
        ctx.org,
        ctx.membership.user_id,
        body.scope,
        body.text_version,
        body.providers,
        client_address(request) if request.client else None,
        subject_id=subject_id,
    )
    return ConsentOut(
        id=consent.id,
        scope=consent.scope,
        providers=list(consent.providers or []),
        text_version=consent.text_version,
        creation_id=consent.subject_id,
        created_at=consent.created_at,
    )
