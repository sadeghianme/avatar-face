"""Shared dependencies: current user, org membership and role enforcement.

Org scoping rule: the org is ALWAYS derived from the path (or the resource
being accessed), never from a client-supplied org_id in a body or query —
that would let any authenticated user act inside someone else's org.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Path, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Auth401, Forbidden403, NotFound404
from app.core.security import decode_token
from app.db import get_db
from app.models import ROLE_RANK, Membership, Organization, Role, User

DB = Annotated[AsyncSession, Depends(get_db)]


async def get_current_user(request: Request, db: DB) -> User:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise Auth401("Missing bearer token", code="missing_token")
    user_id = decode_token(auth[7:], "access")
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise Auth401("User no longer exists", code="unknown_user")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


class OrgContext:
    def __init__(self, org: Organization, membership: Membership):
        self.org = org
        self.membership = membership

    @property
    def role(self) -> Role:
        return self.membership.role


def require_org(min_role: Role = Role.member):
    async def dependency(
        org_id: Annotated[str, Path()],
        user: CurrentUser,
        db: DB,
    ) -> OrgContext:
        org = (
            await db.execute(select(Organization).where(Organization.id == org_id))
        ).scalar_one_or_none()
        if org is None:
            raise NotFound404("Organization not found", code="org_not_found")
        membership = (
            await db.execute(
                select(Membership).where(
                    Membership.org_id == org_id, Membership.user_id == user.id
                )
            )
        ).scalar_one_or_none()
        if membership is None:
            # Non-members get 404, not 403: don't leak org existence.
            raise NotFound404("Organization not found", code="org_not_found")
        if ROLE_RANK[membership.role] < ROLE_RANK[min_role]:
            raise Forbidden403(
                f"Requires {min_role.value} role or higher", code="insufficient_role"
            )
        return OrgContext(org, membership)

    return dependency


OrgMember = Annotated[OrgContext, Depends(require_org(Role.member))]
OrgAdmin = Annotated[OrgContext, Depends(require_org(Role.admin))]
OrgOwner = Annotated[OrgContext, Depends(require_org(Role.owner))]
