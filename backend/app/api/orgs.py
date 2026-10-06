from __future__ import annotations

from fastapi import APIRouter, Response

from app.api.deps import DB, CurrentUser, OrgAdmin, OrgMember
from app.models import Invitation, Membership, Organization, Role, User
from app.schemas.org import (
    InviteCreate,
    InviteOut,
    InvitePublic,
    MemberOut,
    OrgCreate,
    OrgUpdate,
    OrgWithRole,
    RoleUpdate,
)
from app.services import orgs

router = APIRouter(tags=["orgs"])


def _with_role(org: Organization, role: Role) -> OrgWithRole:
    return OrgWithRole(
        id=org.id,
        name=org.name,
        created_at=org.created_at,
        third_party_ai_enabled=org.third_party_ai_enabled,
        role=role,
    )


def _member_out(membership: Membership, user: User) -> MemberOut:
    return MemberOut(
        membership_id=membership.id,
        user_id=user.id,
        username=user.username,
        email=user.email,
        display_name=user.display_name,
        role=membership.role,
        joined_at=membership.created_at,
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
    # Read once: after a lost race the session has expired `user`, and
    # touching it then would be IO outside the greenlet (a 500 for the loser).
    user_id = user.id
    org, role, created = await orgs.create_org(db, body.name, user_id, body.personal)
    if not created:
        response.status_code = 200
    return _with_role(org, role)


@router.get("/orgs", response_model=list[OrgWithRole])
async def list_my_orgs(user: CurrentUser, db: DB) -> list[OrgWithRole]:
    return [_with_role(org, role) for org, role in await orgs.orgs_of(db, user.id)]


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
    await orgs.update_org(db, ctx.org, body.name, body.third_party_ai_enabled)
    return _with_role(ctx.org, ctx.role)


# --- Members ---


@router.get("/orgs/{org_id}/members", response_model=list[MemberOut])
async def list_members(ctx: OrgMember, db: DB) -> list[MemberOut]:
    return [_member_out(m, u) for m, u in await orgs.members(db, ctx.org.id)]


@router.patch("/orgs/{org_id}/members/{membership_id}", response_model=MemberOut)
async def change_role(
    membership_id: str, body: RoleUpdate, ctx: OrgAdmin, db: DB
) -> MemberOut:
    membership, user = await orgs.change_role(db, ctx.org.id, membership_id, body.role, ctx.role)
    return _member_out(membership, user)


@router.delete("/orgs/{org_id}/members/{membership_id}", status_code=204)
async def remove_member(membership_id: str, ctx: OrgAdmin, db: DB):
    await orgs.remove_member(db, ctx.org.id, membership_id, ctx.membership)


# --- Invitations ---


@router.post("/orgs/{org_id}/invitations", response_model=InviteOut, status_code=201)
async def create_invitation(body: InviteCreate, ctx: OrgAdmin, db: DB) -> Invitation:
    return await orgs.invite(db, ctx.org.id, body.email, body.role, ctx.membership)


@router.get("/orgs/{org_id}/invitations", response_model=list[InviteOut])
async def list_invitations(ctx: OrgAdmin, db: DB) -> list[Invitation]:
    return await orgs.invitations(db, ctx.org.id)


@router.delete("/orgs/{org_id}/invitations/{invitation_id}", status_code=204)
async def revoke_invitation(invitation_id: str, ctx: OrgAdmin, db: DB):
    await orgs.revoke_invitation(db, ctx.org.id, invitation_id)


# --- Accepting (token-based; org derived from the invitation, not the client) ---


@router.get("/invitations/{token}", response_model=InvitePublic)
async def get_invitation(token: str, db: DB) -> InvitePublic:
    invitation, org = await orgs.pending_invitation(db, token)
    return InvitePublic(org_name=org.name, email=invitation.email, role=invitation.role)


@router.post("/invitations/{token}/accept", response_model=OrgWithRole)
async def accept_invitation(token: str, user: CurrentUser, db: DB) -> OrgWithRole:
    org, role = await orgs.accept_invitation(db, token, user)
    return _with_role(org, role)
