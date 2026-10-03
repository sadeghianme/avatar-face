from __future__ import annotations

from fastapi import APIRouter, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DB, CurrentUser, OrgAdmin, OrgMember, OrgOwner
from app.core.errors import Conflict409, NotFound404, Validation422
from app.models import Invitation, Membership, Organization, Role, User, utcnow
from app.schemas.org import (
    InviteCreate,
    InviteOut,
    InvitePublic,
    MemberOut,
    OrgCreate,
    OrgOut,
    OrgUpdate,
    OrgWithRole,
    RoleUpdate,
)

router = APIRouter(tags=["orgs"])


def _with_role(org: Organization, role: Role) -> OrgWithRole:
    return OrgWithRole(
        id=org.id,
        name=org.name,
        created_at=org.created_at,
        third_party_ai_enabled=org.third_party_ai_enabled,
        role=role,
    )


@router.post("/orgs", response_model=OrgWithRole, status_code=201)
async def create_org(
    body: OrgCreate, user: CurrentUser, db: DB, response: Response
) -> OrgWithRole:
    """Create an organization, the caller its owner.

    `personal: true` is the account's own organization, made automatically on
    first login. It is idempotent: a user has at most one, and asking again
    (a retry, a second tab, an effect that fired twice) answers 200 with the
    one that exists instead of making another."""
    # Read once: after the rollback below, the session has expired `user`, and
    # touching it then would be IO outside the greenlet (a 500 for the loser).
    user_id = user.id
    if body.personal:
        existing = await _personal_org(db, user_id)
        if existing is not None:
            response.status_code = 200
            return existing
    org = Organization(name=body.name, personal_owner_id=user_id if body.personal else None)
    db.add(org)
    try:
        await db.flush()
        db.add(Membership(user_id=user_id, org_id=org.id, role=Role.owner))
        await db.commit()
    except IntegrityError:
        # Lost the race to another request for the same user's personal org.
        await db.rollback()
        existing = await _personal_org(db, user_id) if body.personal else None
        if existing is None:
            raise
        response.status_code = 200
        return existing
    return _with_role(org, Role.owner)


async def _personal_org(db, user_id: str) -> OrgWithRole | None:
    row = (
        await db.execute(
            select(Organization, Membership.role)
            .join(Membership, Membership.org_id == Organization.id)
            .where(Organization.personal_owner_id == user_id, Membership.user_id == user_id)
        )
    ).first()
    return _with_role(row[0], row[1]) if row else None


@router.get("/orgs", response_model=list[OrgWithRole])
async def list_my_orgs(user: CurrentUser, db: DB) -> list[OrgWithRole]:
    rows = (
        await db.execute(
            select(Organization, Membership.role)
            .join(Membership, Membership.org_id == Organization.id)
            .where(Membership.user_id == user.id)
            .order_by(Organization.created_at)
        )
    ).all()
    return [_with_role(org, role) for org, role in rows]


@router.get("/orgs/{org_id}", response_model=OrgWithRole)
async def get_org(ctx: OrgMember) -> OrgWithRole:
    return _with_role(ctx.org, ctx.role)


@router.patch("/orgs/{org_id}", response_model=OrgWithRole)
async def update_org(body: OrgUpdate, ctx: OrgAdmin, db: DB) -> OrgWithRole:
    """Rename the organization, or switch third-party AI on or off.

    Admins and owners only. Turning third-party AI off takes effect on the
    next request: every step that would send a photo to Google is refused
    (403 third_party_ai_disabled), including ones a member already agreed
    to. Jobs already running finish; they were admitted while it was on.
    """
    if body.name is not None:
        ctx.org.name = body.name
    if body.third_party_ai_enabled is not None:
        ctx.org.third_party_ai_enabled = body.third_party_ai_enabled
    await db.commit()
    return _with_role(ctx.org, ctx.role)


# --- Members ---


@router.get("/orgs/{org_id}/members", response_model=list[MemberOut])
async def list_members(ctx: OrgMember, db: DB) -> list[MemberOut]:
    rows = (
        await db.execute(
            select(Membership, User)
            .join(User, User.id == Membership.user_id)
            .where(Membership.org_id == ctx.org.id)
            .order_by(Membership.created_at)
        )
    ).all()
    return [
        MemberOut(
            membership_id=m.id,
            user_id=u.id,
            username=u.username,
            email=u.email,
            display_name=u.display_name,
            role=m.role,
            joined_at=m.created_at,
        )
        for m, u in rows
    ]


async def _owner_count(db: DB, org_id: str) -> int:
    return (
        await db.execute(
            select(func.count())
            .select_from(Membership)
            .where(Membership.org_id == org_id, Membership.role == Role.owner)
        )
    ).scalar_one()


@router.patch("/orgs/{org_id}/members/{membership_id}", response_model=MemberOut)
async def change_role(
    membership_id: str, body: RoleUpdate, ctx: OrgAdmin, db: DB
) -> MemberOut:
    membership = (
        await db.execute(
            select(Membership).where(
                Membership.id == membership_id, Membership.org_id == ctx.org.id
            )
        )
    ).scalar_one_or_none()
    if membership is None:
        raise NotFound404("Member not found", code="member_not_found")
    # Only owners can grant/revoke the owner role.
    if (body.role == Role.owner or membership.role == Role.owner) and ctx.role != Role.owner:
        raise Validation422("Only owners can change owner roles", code="owner_required")
    if (
        membership.role == Role.owner
        and body.role != Role.owner
        and await _owner_count(db, ctx.org.id) <= 1
    ):
        raise Conflict409("Cannot demote the last owner", code="last_owner")
    membership.role = body.role
    await db.commit()
    user = (await db.execute(select(User).where(User.id == membership.user_id))).scalar_one()
    return MemberOut(
        membership_id=membership.id,
        user_id=user.id,
        username=user.username,
        email=user.email,
        display_name=user.display_name,
        role=membership.role,
        joined_at=membership.created_at,
    )


@router.delete("/orgs/{org_id}/members/{membership_id}", status_code=204)
async def remove_member(membership_id: str, ctx: OrgAdmin, db: DB):
    membership = (
        await db.execute(
            select(Membership).where(
                Membership.id == membership_id, Membership.org_id == ctx.org.id
            )
        )
    ).scalar_one_or_none()
    if membership is None:
        raise NotFound404("Member not found", code="member_not_found")
    is_self = membership.user_id == ctx.membership.user_id
    if membership.role == Role.owner:
        if ctx.role != Role.owner and not is_self:
            raise Validation422("Only owners can remove owners", code="owner_required")
        if await _owner_count(db, ctx.org.id) <= 1:
            raise Conflict409("Cannot remove the last owner", code="last_owner")
    await db.delete(membership)
    await db.commit()


# --- Invitations ---


@router.post("/orgs/{org_id}/invitations", response_model=InviteOut, status_code=201)
async def create_invitation(body: InviteCreate, ctx: OrgAdmin, db: DB) -> Invitation:
    if body.role == Role.owner and ctx.role != Role.owner:
        raise Validation422("Only owners can invite owners", code="owner_required")
    existing_member = (
        await db.execute(
            select(Membership)
            .join(User, User.id == Membership.user_id)
            .where(Membership.org_id == ctx.org.id, User.email == body.email.lower())
        )
    ).scalar_one_or_none()
    if existing_member is not None:
        raise Conflict409("Already a member", code="already_member")
    invitation = Invitation(
        org_id=ctx.org.id,
        email=body.email.lower(),
        role=body.role,
        invited_by_id=ctx.membership.user_id,
    )
    db.add(invitation)
    await db.commit()
    return invitation


@router.get("/orgs/{org_id}/invitations", response_model=list[InviteOut])
async def list_invitations(ctx: OrgAdmin, db: DB) -> list[Invitation]:
    return list(
        (
            await db.execute(
                select(Invitation)
                .where(Invitation.org_id == ctx.org.id)
                .order_by(Invitation.created_at.desc())
            )
        )
        .scalars()
        .all()
    )


@router.delete("/orgs/{org_id}/invitations/{invitation_id}", status_code=204)
async def revoke_invitation(invitation_id: str, ctx: OrgAdmin, db: DB):
    invitation = (
        await db.execute(
            select(Invitation).where(
                Invitation.id == invitation_id, Invitation.org_id == ctx.org.id
            )
        )
    ).scalar_one_or_none()
    if invitation is None:
        raise NotFound404("Invitation not found", code="invitation_not_found")
    if not invitation.is_pending:
        raise Conflict409("Invitation is no longer pending", code="invitation_closed")
    invitation.revoked_at = utcnow()
    await db.commit()


# --- Accepting (token-based; org derived from the invitation, not the client) ---


@router.get("/invitations/{token}", response_model=InvitePublic)
async def get_invitation(token: str, db: DB) -> InvitePublic:
    invitation = (
        await db.execute(select(Invitation).where(Invitation.token == token))
    ).scalar_one_or_none()
    if invitation is None or not invitation.is_pending:
        raise NotFound404("Invitation not found or expired", code="invitation_not_found")
    org = (
        await db.execute(select(Organization).where(Organization.id == invitation.org_id))
    ).scalar_one()
    return InvitePublic(org_name=org.name, email=invitation.email, role=invitation.role)


@router.post("/invitations/{token}/accept", response_model=OrgWithRole)
async def accept_invitation(token: str, user: CurrentUser, db: DB) -> OrgWithRole:
    invitation = (
        await db.execute(select(Invitation).where(Invitation.token == token))
    ).scalar_one_or_none()
    if invitation is None or not invitation.is_pending:
        raise NotFound404("Invitation not found or expired", code="invitation_not_found")
    if invitation.email != user.email:
        raise Validation422(
            "Invitation was issued for a different email", code="email_mismatch"
        )
    already = (
        await db.execute(
            select(Membership).where(
                Membership.org_id == invitation.org_id, Membership.user_id == user.id
            )
        )
    ).scalar_one_or_none()
    if already is not None:
        raise Conflict409("Already a member", code="already_member")
    db.add(Membership(user_id=user.id, org_id=invitation.org_id, role=invitation.role))
    invitation.accepted_at = utcnow()
    org = (
        await db.execute(select(Organization).where(Organization.id == invitation.org_id))
    ).scalar_one()
    await db.commit()
    return _with_role(org, invitation.role)
