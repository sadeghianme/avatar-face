"""Build layer sets for avatars that predate layered rendering.

One-off, idempotent: ready photo avatars whose has_layers is False get a
decomposition built from their current image and rig; everything else is
untouched. Run inside the API container:

    python -m scripts.backfill_layers
"""

import asyncio
import json


async def main() -> None:
    from sqlalchemy import select

    from app.db import get_session_factory
    from app.models import Avatar, AvatarKind, AvatarStatus
    from app.services.layers import store_layers
    from app.services.storage import get_storage

    storage = get_storage()
    async with get_session_factory()() as db:
        avatars = (
            (
                await db.execute(
                    select(Avatar).where(
                        Avatar.kind == AvatarKind.photo,
                        Avatar.status == AvatarStatus.ready,
                        Avatar.has_layers.is_(False),
                        Avatar.rig_key.is_not(None),
                        Avatar.image_key.is_not(None),
                    )
                )
            )
            .scalars()
            .all()
        )
        print(f"{len(avatars)} avatar(s) to backfill")
        for avatar in avatars:
            try:
                rig = json.loads(await storage.get_bytes(avatar.rig_key))
                if not rig.get("face_box"):
                    print(f"  {avatar.id} {avatar.name!r}: no face_box, skipped")
                    continue
                image = await storage.get_bytes(avatar.image_key)
                avatar.has_layers = await store_layers(avatar, storage, image, rig["face_box"])
                print(f"  {avatar.id} {avatar.name!r}: {'ok' if avatar.has_layers else 'FAILED'}")
            except Exception as exc:  # keep going; one bad avatar must not stop the rest
                print(f"  {avatar.id} {avatar.name!r}: error {exc}")
        await db.commit()


if __name__ == "__main__":
    asyncio.run(main())
