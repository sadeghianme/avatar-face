"""Consents: recorded before a photo leaves the server, and before a person's
likeness goes live.

Principle 4 of docs/avatar-lines.md: consent follows the data, not the line.
Any step that sends pixels to a third party (AI adjust, AI point finding,
generation from a source photo) requires a consent that names the provider,
made by the person pressing the button, in this organization, under the
wording in force now. Without one every line still works by hand.

The wording itself lives in the dashboard, translated; the server keeps only
its VERSION per scope (TEXT_VERSIONS). A consent records the version it was
given under, and a step accepts only the current one: when the text changes
(a new provider, a new use), everyone is asked again rather than held to a
statement they never read. A version the server does not know is refused at
the door, so a stale or forged client cannot record agreement to a text
that was never shown.

Three scopes:

- `third_party_ai`: "the photo I upload, or the description I type, and
  crops of my avatar's face are sent to Google (Gemini) to create and adjust
  my avatar". Refused outright (403 third_party_ai_disabled) when the
  organization has turned third-party AI off. About sending photos, not
  about one photo, so it is remembered per person and wording. Its wording
  of 2026-10-03 describes the four-step wizard: the upload or the
  description sent to make the avatar's picture in the chosen style, again
  at every retry or change, the picture again for an animal's or a
  drawing's points, and a realistic person's teeth and mouth shapes at
  publish or from the Mouth panel (a crop of the face sent for the teeth
  and for each of six speech sounds, and once more for any the AI declined;
  services.mouth_kit). It says the results are kept with the avatar and
  published with it, labelled as made by AI, and that pictures are never
  used to train AI. Agreements to an earlier text no longer count: every
  member is asked once more (frontend useConsent / the wizard's Photo
  screen).
- `depiction`: "I am this person or have their permission, and they are 18
  or older". Required to finish a creation made from a person's photo, AI
  or not, on whatever line it ends up (services.creations.statement_for):
  an avatar is a person's face talking on someone's site.
- `generated_face`: "this face was made by AI and is not a real,
  identifiable person". The same place in the flow, for a face the image
  model made from words, of which "I am this person" cannot be true.

The two statements about a face are about ONE face: each is recorded for
one creation (`subject_id`) and accepted only for it, so an old statement
about someone else can never stand behind a new avatar.
"""

from __future__ import annotations

import hashlib
import hmac

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import Forbidden403, Validation422
from app.models import Consent, Organization
from app.services.ai_models import PROVIDER as GOOGLE

THIRD_PARTY_AI = "third_party_ai"
DEPICTION = "depiction"
GENERATED_FACE = "generated_face"
SCOPES = (THIRD_PARTY_AI, DEPICTION, GENERATED_FACE)
# Statements about the face in one creation: bound to it (`subject_id`).
SUBJECT_SCOPES = frozenset({DEPICTION, GENERATED_FACE})

# The version of the wording the dashboard shows for each scope. Bump one
# whenever its text changes in meaning (en and fr together): every consent
# given under the old text stops being accepted, and people are asked again.
TEXT_VERSIONS: dict[str, str] = {
    THIRD_PARTY_AI: "2026-10-03",
    DEPICTION: "2026-09-25",
    GENERATED_FACE: "2026-09-25",
}

# Providers a third-party AI consent may name. One today: every model this
# server calls is Google's (services.ai_models).
KNOWN_PROVIDERS = frozenset({GOOGLE})

# Domain separation for the address hash: the JWT secret signs tokens, and
# the same key must never produce a value that means something else.
_IP_HASH_CONTEXT = b"liveface consent ip v1:"


def ip_hash(ip: str | None) -> str | None:
    """A keyed SHA-256 of the address (HMAC with a server secret), or None.

    Keyed, not a bare hash: the IPv4 space is small enough that a plain
    sha256(ip) is reversed by trying every address. Without the secret this
    says nothing; with it, only whether two statements came from the same
    address.
    """
    if not ip:
        return None
    key = _IP_HASH_CONTEXT + get_settings().jwt_secret.encode()
    return hmac.new(key, ip.encode(), hashlib.sha256).hexdigest()


def require_ai_enabled(org: Organization) -> None:
    """403 when this organization has switched third-party AI off."""
    if not org.third_party_ai_enabled:
        raise Forbidden403(
            "Your organization has turned off third-party AI; an owner or admin can "
            "turn it back on in Settings",
            code="third_party_ai_disabled",
        )


async def ai_switched_off(org_id: str) -> bool:
    """Has the organization turned third-party AI off? Read in a session of
    its own, so work that waited (a queued job, a provider call 90 s after
    the last) asks the database as it is now, not as its request saw it."""
    from app.db import get_session_factory

    async with get_session_factory()() as db:
        enabled = (
            await db.execute(
                select(Organization.third_party_ai_enabled).where(Organization.id == org_id)
            )
        ).scalar_one_or_none()
    return not enabled


async def record(
    db: AsyncSession,
    org: Organization,
    user_id: str,
    scope: str,
    text_version: str,
    providers: list[str] | None,
    ip: str | None,
    subject_id: str | None = None,
) -> Consent:
    """Store one statement and return it. Refuses an unknown scope or
    wording version (422), an unknown provider or an empty list of them
    (422), a statement about a face without the creation it is about (422),
    and a third-party AI consent in an organization that has turned it off
    (403). The caller checks that `subject_id` is a creation of `org`."""
    if scope not in TEXT_VERSIONS:
        raise Validation422("Unknown consent", code="unknown_consent_scope")
    if text_version != TEXT_VERSIONS[scope]:
        raise Validation422(
            "This consent text is out of date; reload the page and read it again",
            code="unknown_consent_version",
            extra={"current_version": TEXT_VERSIONS[scope]},
        )
    if scope == THIRD_PARTY_AI:
        require_ai_enabled(org)
        # Only an omitted list means "the default provider": an empty one
        # names nobody, and storing Google for it would record agreement to
        # a provider the request did not name.
        named = sorted(set(providers)) if providers is not None else [GOOGLE]
        unknown = [p for p in named if p not in KNOWN_PROVIDERS]
        if unknown or not named:
            raise Validation422(
                f"Unknown AI provider: {', '.join(unknown) or 'none named'}",
                code="unknown_provider",
            )
        subject_id = None
    else:
        # The statement is about the face in one creation, not a provider.
        named = []
        if not subject_id:
            raise Validation422(
                "Say which avatar this statement is about", code="consent_subject_required"
            )
    consent = Consent(
        org_id=org.id,
        user_id=user_id,
        scope=scope,
        providers=named,
        text_version=text_version,
        ip_hash=ip_hash(ip),
        subject_id=subject_id,
    )
    db.add(consent)
    await db.commit()
    return consent


def _required(scope: str) -> Forbidden403:
    detail = {
        THIRD_PARTY_AI: "Agree to send this photo to Google (Gemini) first",
        DEPICTION: (
            "Confirm that you are this person or have their permission, and that they "
            "are 18 or older"
        ),
        GENERATED_FACE: (
            "Confirm that this face was made by AI and is not a real, identifiable person"
        ),
    }[scope]
    return Forbidden403(
        detail,
        code="consent_required",
        extra={"scope": scope, "text_version": TEXT_VERSIONS[scope]},
    )


async def require(
    db: AsyncSession,
    consent_id: str | None,
    org: Organization,
    user_id: str,
    scope: str,
    provider: str | None = None,
    subject_id: str | None = None,
) -> Consent:
    """The consent `consent_id`, if it is this user's, in this org, for
    `scope` (naming `provider`; about `subject_id`, for a statement about a
    face), under the current wording. Otherwise 403 consent_required, whose
    `scope` and `text_version` say what to ask for.

    Someone else's consent never counts, even in the same organization: the
    statement is personal ("I am this person or have their permission").
    Nor does a statement about another creation's face: it said nothing
    about this one.
    """
    if scope == THIRD_PARTY_AI:
        require_ai_enabled(org)
    if not consent_id:
        raise _required(scope)
    consent = (
        await db.execute(
            select(Consent).where(
                Consent.id == consent_id,
                Consent.org_id == org.id,
                Consent.user_id == user_id,
                Consent.scope == scope,
            )
        )
    ).scalar_one_or_none()
    if consent is None or consent.text_version != TEXT_VERSIONS[scope]:
        raise _required(scope)
    if provider is not None and provider not in (consent.providers or []):
        raise _required(scope)
    if scope in SUBJECT_SCOPES and (not subject_id or consent.subject_id != subject_id):
        raise _required(scope)
    return consent


async def latest(
    db: AsyncSession, org: Organization, user_id: str, scope: str
) -> Consent | None:
    """This user's most recent consent in this org for `scope` that `require`
    would accept today (the current wording; for third_party_ai, naming
    every provider it is asked for), or None.

    What lets the dashboard ask once per person and wording rather than per
    photo: the statement is about sending photos to Google, not about one
    photo. Never for a statement about a face, which is about one creation
    and is asked for each. A new wording version (TEXT_VERSIONS) makes this None again, so
    everyone is asked the new question. Whether the organization allows
    third-party AI at all is `require`'s question, asked at every step.
    """
    if scope in SUBJECT_SCOPES:
        return None
    rows = (
        await db.execute(
            select(Consent)
            .where(
                Consent.org_id == org.id,
                Consent.user_id == user_id,
                Consent.scope == scope,
                Consent.text_version == TEXT_VERSIONS[scope],
            )
            .order_by(Consent.created_at.desc(), Consent.id.desc())
        )
    ).scalars()
    for consent in rows:
        if scope != THIRD_PARTY_AI or GOOGLE in (consent.providers or []):
            return consent
    return None


async def agreed_before(
    db: AsyncSession, org: Organization, user_id: str, scope: str
) -> bool:
    """True when this user recorded `scope` in this org under an EARLIER
    wording (any version other than the one in force). With `latest` being
    None it means "agreed before, the words changed", which the dashboard
    says to the member instead of showing an unexplained empty checkbox."""
    if scope in SUBJECT_SCOPES:
        return False
    found = (
        await db.execute(
            select(Consent.id)
            .where(
                Consent.org_id == org.id,
                Consent.user_id == user_id,
                Consent.scope == scope,
                Consent.text_version != TEXT_VERSIONS[scope],
            )
            .limit(1)
        )
    ).first()
    return found is not None


async def statement_about(
    db: AsyncSession, org: Organization, user_id: str, scope: str, subject_id: str
) -> Consent | None:
    """This user's latest statement `scope` about the face in creation
    `subject_id`, under the wording in force, or None.

    The four-step wizard asks for the statement where the photo or the
    description is given (its step 2) and records it for the creation as
    soon as the creation exists; finishing then finds it here instead of
    asking again. Still this user's own, about this face, under the current
    words: exactly what `require` accepts.
    """
    if scope not in SUBJECT_SCOPES:
        return None
    return (
        await db.execute(
            select(Consent)
            .where(
                Consent.org_id == org.id,
                Consent.user_id == user_id,
                Consent.scope == scope,
                Consent.subject_id == subject_id,
                Consent.text_version == TEXT_VERSIONS[scope],
            )
            .order_by(Consent.created_at.desc(), Consent.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


def with_consent(consent_ids: list | None, consent_id: str) -> list:
    """`consent_ids` with `consent_id` appended once (a new list: JSON
    columns are replaced, never mutated)."""
    ids = list(consent_ids or [])
    if consent_id not in ids:
        ids.append(consent_id)
    return ids
