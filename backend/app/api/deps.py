"""Shared dependencies: current user, org membership and role enforcement.

Org scoping rule: the org is ALWAYS derived from the path (or the resource
being accessed), never from a client-supplied org_id in a body or query —
that would let any authenticated user act inside someone else's org.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Path, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.client_ip import client_ip
from app.core.errors import Auth401, Forbidden403, NotFound404
from app.core.security import decode_token
from app.db import get_db
from app.models import ROLE_RANK, Membership, Organization, Role, User
from app.services import accounts, orgs

DB = Annotated[AsyncSession, Depends(get_db)]


def client_address(request: Request) -> str:
    """The caller's address, through the proxies this server trusts
    (core.client_ip: Cloudflare's CF-Connecting-IP behind Caddy in
    production). Every per-client limit and every recorded address uses
    this, never `request.client` directly; "unknown" only for a transport
    that has no peer at all.
    """
    return client_ip(request)


async def get_current_user(request: Request, db: DB) -> User:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise Auth401("Missing bearer token", code="missing_token")
    user_id = decode_token(auth[7:], "access")
    return await accounts.require_user(db, user_id)


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
        org = await orgs.get_org(db, org_id)
        if org is None:
            raise NotFound404("Organization not found", code="org_not_found")
        membership = await orgs.membership_of(db, org_id, user.id)
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
