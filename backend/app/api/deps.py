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
from app.core.config import get_settings
from app.core.errors import Auth401, Forbidden403, NotFound404
from app.core.security import AccessClaims, decode_access_token
from app.db import get_db
from app.models import ROLE_RANK, Membership, Organization, Role, User
from app.services import orgs, sessions

DB = Annotated[AsyncSession, Depends(get_db)]


def client_address(request: Request) -> str:
    """The caller's address, through the proxies this server trusts
    (core.client_ip: Cloudflare's CF-Connecting-IP behind Caddy in
    production). Every per-client limit and every recorded address uses
    this, never `request.client` directly; "unknown" only for a transport
    that has no peer at all.
    """
    return client_ip(request)


def access_claims(request: Request) -> AccessClaims:
    """The bearer token's claims: 401 `missing_token` without one,
    `invalid_token` for one that is not a valid access token."""
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise Auth401("Missing bearer token", code="missing_token")
    return decode_access_token(auth[7:])


async def get_current_user(request: Request, db: DB) -> User:
    """The signed-in user, while the token's session is open
    (services.sessions.session_user: 401 `session_revoked` once it ends)."""
    return await sessions.session_user(db, access_claims(request))


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_same_origin(request: Request) -> None:
    """Refuse a request another site's page made: the guard on every route
    the session cookie authenticates or sets (api.auth).

    The cookie is SameSite=Strict, so a browser does not send it with a
    request from another site at all. This is the second lock, for what
    SameSite leaves open (a sibling subdomain is "same site"; an old
    browser ignores the attribute):

    * `Sec-Fetch-Site`, which every current browser sends and no page can
      set, must be `same-origin`;
    * without it, `Origin`, when there is one, must be one of the
      dashboard's own (Settings.dashboard_origins).

    A request with neither came from no web page (curl, a script, the
    tests); it carries no ambient cookie to abuse. 403 `cross_site_request`.
    """
    site = request.headers.get("sec-fetch-site")
    if site is not None:
        if site.lower() != "same-origin":
            raise Forbidden403(
                "Refused: this request did not come from the dashboard",
                code="cross_site_request",
            )
        return
    origin = request.headers.get("origin")
    if origin is not None and origin.rstrip("/").lower() not in get_settings().dashboard_origins:
        raise Forbidden403(
            "Refused: this request did not come from the dashboard", code="cross_site_request"
        )


SameOrigin = Depends(require_same_origin)


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
