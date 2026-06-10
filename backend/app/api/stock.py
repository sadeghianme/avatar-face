from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Response
from pydantic import BaseModel, Field

from app.api.deps import DB, OrgMember
from app.core.config import get_settings
from app.core.errors import NotFound404
from app.models import Avatar
from app.schemas.avatar import AvatarOut
from app.services.rig import process_avatar
from app.services.stock import STOCK_STYLES, get_stock_image
from app.services.storage import get_storage

router = APIRouter(tags=["stock"])


class StockAvatarOut(BaseModel):
    id: str
    name: str
    image_url: str


class FromStockRequest(BaseModel):
    stock_id: str
    name: str = Field(default="", max_length=128)


@router.get("/stock-avatars", response_model=list[StockAvatarOut])
async def list_stock_avatars() -> list[StockAvatarOut]:
    base = get_settings().public_base_url.rstrip("/")
    return [
        StockAvatarOut(id=s.id, name=s.name, image_url=f"{base}/stock-avatars/{s.id}.png")
        for s in STOCK_STYLES
    ]


@router.get("/stock-avatars/{style_id}.png")
async def stock_avatar_image(style_id: str) -> Response:
    data = get_stock_image(style_id)
    if data is None:
        raise NotFound404("Unknown stock avatar", code="stock_not_found")
    return Response(
        content=data,
        media_type="image/png",
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400"},
    )


@router.post("/orgs/{org_id}/avatars/from-stock", response_model=AvatarOut, status_code=201)
async def create_from_stock(
    body: FromStockRequest, ctx: OrgMember, db: DB, background: BackgroundTasks
) -> Avatar:
    data = get_stock_image(body.stock_id)
    if data is None:
        raise NotFound404("Unknown stock avatar", code="stock_not_found")
    style = next(s for s in STOCK_STYLES if s.id == body.stock_id)
    avatar = Avatar(
        org_id=ctx.org.id,
        created_by_id=ctx.membership.user_id,
        name=body.name or style.name,
        content_type="image/png",
    )
    db.add(avatar)
    await db.flush()
    avatar.image_key = f"orgs/{ctx.org.id}/avatars/{avatar.id}/source.png"
    await get_storage().put_bytes(avatar.image_key, data, "image/png")
    await db.commit()
    background.add_task(process_avatar, avatar.id)
    return avatar
