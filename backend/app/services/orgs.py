"""Organizations, their members and invitations: the queries and writes
behind api.orgs and the membership check every org-scoped route makes
(api.deps.require_org).

The org is always the one the caller is already authorized for (from the
path, through the membership check) or the one an invitation names; nothing
here takes an org id a client chose. Role rules that are about the
organization itself (only an owner touches an owner, an org keeps at least
one) are enforced here, with the same errors whichever route asks.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict409, NotFound404, Validation422
from app.models import Invitation, Membership, Organization, Role, User, utcnow

# --- Organizations ---------------------------------------------------------------


async def get_org(db: AsyncSession, org_id: str) -> Organization | None:
    return (
        await db.execute(select(Organization).where(Organization.id == org_id))
    ).scalar_one_or_none()


async def loaded_org(db: AsyncSession, org_id: str) -> Organization | None:
    """The org, from the session's identity map when it is loaded there (the
    route's membership check loads it, so this is no query then)."""
    return await db.get(Organization, org_id)


async def membership_of(db: AsyncSession, org_id: str, user_id: str) -> Membership | None:
    return (
        await db.execute(
            select(Membership).where(Membership.org_id == org_id, Membership.user_id == user_id)
        )
    ).scalar_one_or_none()


async def personal_org(db: AsyncSession, user_id: str) -> tuple[Organization, Role] | None:
    """The user's own organization, made on first login, with their role."""
    row = (
        await db.execute(
            select(Organization, Membership.role)
            .join(Membership, Membership.org_id == Organization.id)
            .where(Organization.personal_owner_id == user_id, Membership.user_id == user_id)
        )
    ).first()
    return (row[0], row[1]) if row else None


async def create_org(
    db: AsyncSession, name: str, user_id: str, personal: bool
) -> tuple[Organization, Role, bool]:
    """(org, the caller's role, whether it was made now). The caller owns it.

    A personal organization is made at most once per user: asking again
    answers with the one that exists, including when two requests race to
    make it (the loser of the unique index reads the winner's).
    """
    if personal:
        existing = await personal_org(db, user_id)
        if existing is not None:
            return (*existing, False)
    org = Organization(name=name, personal_owner_id=user_id if personal else None)
    db.add(org)
    try:
        await db.flush()
        db.add(Membership(user_id=user_id, org_id=org.id, role=Role.owner))
        await db.commit()
    except IntegrityError:
        # Lost the race to another request for the same user's personal org.
        await db.rollback()
        existing = await personal_org(db, user_id) if personal else None
        if existing is None:
            raise
        return (*existing, False)
    return org, Role.owner, True


async def orgs_of(db: AsyncSession, user_id: str) -> list[tuple[Organization, Role]]:
    """Every organization the user belongs to, oldest first, with their role."""
    rows = (
        await db.execute(
            select(Organization, Membership.role)
            .join(Membership, Membership.org_id == Organization.id)
            .where(Membership.user_id == user_id)
            .order_by(Organization.created_at)
        )
    ).all()
    return [(org, role) for org, role in rows]


async def update_org(
    db: AsyncSession, org: Organization, name: str | None, third_party_ai_enabled: bool | None
) -> None:
    """Rename and/or switch third-party AI; None leaves a field as it is."""
    if name is not None:
        org.name = name
    if third_party_ai_enabled is not None:
        org.third_party_ai_enabled = third_party_ai_enabled
    await db.commit()


# --- Members ---------------------------------------------------------------------


async def members(db: AsyncSession, org_id: str) -> list[tuple[Membership, User]]:
    rows = (
        await db.execute(
            select(Membership, User)
            .join(User, User.id == Membership.user_id)
            .where(Membership.org_id == org_id)
            .order_by(Membership.created_at)
        )
    ).all()
    return [(membership, user) for membership, user in rows]


async def owner_count(db: AsyncSession, org_id: str) -> int:
    return (
        await db.execute(
            select(func.count())
            .select_from(Membership)
            .where(Membership.org_id == org_id, Membership.role == Role.owner)
        )
    ).scalar_one()


async def _member(db: AsyncSession, org_id: str, membership_id: str) -> Membership:
    membership = (
        await db.execute(
            select(Membership).where(Membership.id == membership_id, Membership.org_id == org_id)
        )
    ).scalar_one_or_none()
    if membership is None:
        raise NotFound404("Member not found", code="member_not_found")
    return membership


async def change_role(
    db: AsyncSession, org_id: str, membership_id: str, role: Role, acting_role: Role
) -> tuple[Membership, User]:
    """Give a member `role`, as someone with `acting_role`; the member after."""
    membership = await _member(db, org_id, membership_id)
    # Only owners can grant/revoke the owner role.
    if (role == Role.owner or membership.role == Role.owner) and acting_role != Role.owner:
        raise Validation422("Only owners can change owner roles", code="owner_required")
    if membership.role == Role.owner and role != Role.owner and await owner_count(db, org_id) <= 1:
        raise Conflict409("Cannot demote the last owner", code="last_owner")
    membership.role = role
    await db.commit()
    user = (await db.execute(select(User).where(User.id == membership.user_id))).scalar_one()
    return membership, user


async def remove_member(
    db: AsyncSession, org_id: str, membership_id: str, acting: Membership
) -> None:
    """Remove a member (or yourself), as the `acting` membership."""
    membership = await _member(db, org_id, membership_id)
    is_self = membership.user_id == acting.user_id
    if membership.role == Role.owner:
        if acting.role != Role.owner and not is_self:
            raise Validation422("Only owners can remove owners", code="owner_required")
        if await owner_count(db, org_id) <= 1:
            raise Conflict409("Cannot remove the last owner", code="last_owner")
    await db.delete(membership)
    await db.commit()


# --- Invitations -----------------------------------------------------------------


async def invite(
    db: AsyncSession, org_id: str, email: str, role: Role, acting: Membership
) -> Invitation:
    """Invite `email` with `role`, as the `acting` membership."""
    if role == Role.owner and acting.role != Role.owner:
        raise Validation422("Only owners can invite owners", code="owner_required")
    existing_member = (
        await db.execute(
            select(Membership)
            .join(User, User.id == Membership.user_id)
            .where(Membership.org_id == org_id, User.email == email.lower())
        )
    ).scalar_one_or_none()
    if existing_member is not None:
        raise Conflict409("Already a member", code="already_member")
    invitation = Invitation(
        org_id=org_id,
        email=email.lower(),
        role=role,
        invited_by_id=acting.user_id,
    )
    db.add(invitation)
    await db.commit()
    return invitation


async def invitations(db: AsyncSession, org_id: str) -> list[Invitation]:
    """Newest first, whatever their state."""
    return list(
        (
            await db.execute(
                select(Invitation)
                .where(Invitation.org_id == org_id)
                .order_by(Invitation.created_at.desc())
            )
        )
        .scalars()
        .all()
    )


async def revoke_invitation(db: AsyncSession, org_id: str, invitation_id: str) -> None:
    invitation = (
        await db.execute(
            select(Invitation).where(Invitation.id == invitation_id, Invitation.org_id == org_id)
        )
    ).scalar_one_or_none()
    if invitation is None:
        raise NotFound404("Invitation not found", code="invitation_not_found")
    if not invitation.is_pending:
        raise Conflict409("Invitation is no longer pending", code="invitation_closed")
    invitation.revoked_at = utcnow()
    await db.commit()


async def _pending(db: AsyncSession, token: str) -> Invitation:
    invitation = (
        await db.execute(select(Invitation).where(Invitation.token == token))
    ).scalar_one_or_none()
    if invitation is None or not invitation.is_pending:
        raise NotFound404("Invitation not found or expired", code="invitation_not_found")
    return invitation


async def _invitation_org(db: AsyncSession, invitation: Invitation) -> Organization:
    return (
        await db.execute(select(Organization).where(Organization.id == invitation.org_id))
    ).scalar_one()


async def pending_invitation(db: AsyncSession, token: str) -> tuple[Invitation, Organization]:
    """A pending invitation by its token, with its organization (404 otherwise)."""
    invitation = await _pending(db, token)
    return invitation, await _invitation_org(db, invitation)


async def accept_invitation(
    db: AsyncSession, token: str, user: User
) -> tuple[Organization, Role]:
    """Join the invitation's organization, as the user it was sent to."""
    invitation = await _pending(db, token)
    if invitation.email != user.email:
        raise Validation422("Invitation was issued for a different email", code="email_mismatch")
    if await membership_of(db, invitation.org_id, user.id) is not None:
        raise Conflict409("Already a member", code="already_member")
    db.add(Membership(user_id=user.id, org_id=invitation.org_id, role=invitation.role))
    invitation.accepted_at = utcnow()
    org = await _invitation_org(db, invitation)
    await db.commit()
    return org, invitation.role
