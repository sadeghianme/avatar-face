"""Cloned voices: audio rendered elsewhere, served from the speech cache.

Voice cloning needs a GPU (or an Apple Silicon laptop) and runs several
times slower than real time, so it cannot happen on this server during a
request. It does not have to: the lines an avatar says on a landing page, in
a product tour or in a demo are known in advance. They are rendered offline
with Chatterbox and uploaded, and this provider serves them.

The storage is the existing speech cache, not a new table. That is not a
shortcut — the cache is already keyed on exactly the tuple that identifies a
rendered line, (provider, voice, locale, text), and synthesize_cached
already returns a hit without consulting any provider. So an uploaded line
IS a cache entry, and the code path that plays it is the same one that plays
a cached Kokoro line.

The consequence worth stating plainly: this provider can only speak what was
uploaded. A miss is a miss, and the caller falls back to a server voice
rather than the avatar going silent. See synthesize() for why that is a
deliberate refusal rather than an approximation.
"""

from __future__ import annotations

from sqlalchemy import distinct, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SpeechCache
from app.services.tts.base import SynthesisResult, TTSProvider, Voice

PROVIDER_NAME = "cloned"


from app.core.errors import NotFound404


class ClonedTTSProvider(TTSProvider):
    name = PROVIDER_NAME
    display_name = "Cloned voice"
    # Per-org, so it is offered by the org-scoped endpoint, never the
    # global provider list.
    listed = False

    def is_configured(self) -> bool:
        # Availability depends on rows in the database, which cannot be
        # inspected here — the interface is synchronous and has no session.
        # The listing endpoint asks the database directly; treating the
        # provider as always-present keeps get_provider() from rejecting a
        # voice that does exist.
        return True

    async def voices(self) -> list[Voice]:
        # Voices are per-organisation rows; the org-scoped endpoint supplies
        # them. An unscoped list would leak one customer's voice names to
        # another.
        return []

    async def synthesize(self, text: str, voice: str, locale: str) -> SynthesisResult:
        """Always a miss.

        A cache hit never reaches a provider, so arriving here means the line
        was not uploaded. Approximating it with a different voice would be
        worse than failing: the whole point of a cloned voice is that it is
        that person, and silently substituting another one is the kind of
        thing nobody notices until a customer does.
        """
        raise NotFound404(
            f"No cloned audio for this line in voice '{voice}'. "
            "Render it offline and upload it, or use a server voice.",
            code="cloned_line_missing",
        )


async def voices_for_org(db: AsyncSession, org_id: str) -> list[Voice]:
    """Cloned voices this org has uploaded, derived from the cache itself."""
    rows = (
        await db.execute(
            select(distinct(SpeechCache.voice)).where(
                SpeechCache.provider == PROVIDER_NAME,
                SpeechCache.voice.like(f"{org_id}:%"),
            )
        )
    ).scalars().all()
    out = []
    for stored in rows:
        _, _, label = stored.partition(":")
        out.append(Voice(id=stored, name=label, locale="", gender="neutral"))
    return out


def scoped_voice_id(org_id: str, name: str) -> str:
    """Cloned voice ids are org-prefixed.

    The cache is global and keyed on (provider, voice, locale, text), so an
    unprefixed name would let two organisations that both cloned "Sarah"
    read each other's audio — and hear each other's scripts.
    """
    return f"{org_id}:{name}"
