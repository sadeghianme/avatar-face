from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import DB, OrgMember
from app.services.usage import usage_summary

router = APIRouter(prefix="/orgs/{org_id}/usage", tags=["usage"])


@router.get("")
async def get_usage(ctx: OrgMember, db: DB) -> dict:
    return await usage_summary(db, ctx.org.id)
