import json
import threading
from datetime import timedelta

from app.api import embed
from app.models import ApiKey, utcnow
from app.schemas.tts import CueOut
from app.services import api_keys
from app.services.rate_limit import Limit
from app.services.tts import timing
from tests.conftest import create_org, create_ready_avatar, register_and_login


async def _setup(client, allowed_domains=None):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    created = await client.post(
        f"/orgs/{org_id}/api-keys",
        json={"name": "widget", "allowed_domains": allowed_domains or []},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    return headers, org_id, avatar_id, created.json()


async def test_api_key_plaintext_shown_once(client):
    headers, org_id, _, created = await _setup(client)
    plaintext = created["plaintext"]
    assert plaintext.startswith("lf_")
    assert created["api_key"]["prefix"] == plaintext[:12]
    listing = (await client.get(f"/orgs/{org_id}/api-keys", headers=headers)).json()
    assert "plaintext" not in listing[0]
    assert "key_hash" not in listing[0]


async def test_embed_avatar_with_key(client):
    _, _, avatar_id, created = await _setup(client)
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"]},
    )
    assert response.status_code == 200
    body = response.json()
    # Absolute URLs so third-party pages can load them.
    assert body["rig_url"].startswith("http://testserver/")
    assert body["thumbnail_url"].startswith("http://testserver/")


async def test_embed_serves_the_full_image_not_the_thumbnail(client):
    """The widget textures from image_url; a 256px thumbnail would be an upscale."""
    _, _, avatar_id, created = await _setup(client)
    body = (
        await client.get(
            f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": created["plaintext"]}
        )
    ).json()
    assert body["image_url"], "embed payload must carry the full-resolution photo"
    # Served from the published snapshot, which is a copy of the source photo
    # rather than the 256px thumbnail.
    assert "thumb" not in body["image_url"], body["image_url"]
    assert "/published/" in body["image_url"], body["image_url"]


async def test_an_edit_does_not_reach_the_embed_until_published(client):
    """The core of the draft/published split.

    Editing and shipping used to be the same action: cropping a photo changed
    what visitors saw before the owner had looked at the result. An edit now
    moves the draft only; embedding sites keep serving the last published
    snapshot until Publish is pressed.
    """
    headers, org_id, avatar_id, created = await _setup(client)
    key = {"X-Api-Key": created["plaintext"]}

    before = (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).json()
    assert before["framing"] == "face"

    patched = await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json={"framing": "full"}, headers=headers
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["unpublished"] is True

    # The dashboard shows the draft...
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["framing"] == "full"
    # ...while visitors still get what was published.
    during = (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).json()
    assert during["framing"] == "face"

    published = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    assert published.status_code == 200, published.text
    assert published.json()["unpublished"] is False

    after = (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).json()
    assert after["framing"] == "full"


async def test_framing_rejects_unknown_values(client):
    headers, org_id, avatar_id, _ = await _setup(client)
    response = await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json={"framing": "sideways"}, headers=headers
    )
    assert response.status_code == 422


async def test_embed_requires_key(client):
    _, _, avatar_id, _ = await _setup(client)
    response = await client.get(f"/embed/v1/avatars/{avatar_id}")
    assert response.status_code == 401


async def test_a_key_in_the_query_string_is_not_accepted(client):
    """Only the X-Api-Key header authenticates: a key in the URL lands in
    access logs, proxies and Referer headers. The widget sends the header."""
    _, _, avatar_id, created = await _setup(client)
    key = created["plaintext"]
    in_url = await client.get(f"/embed/v1/avatars/{avatar_id}", params={"key": key})
    assert in_url.status_code == 401
    assert in_url.json()["code"] == "missing_api_key"
    spoken = await client.post("/embed/v1/synthesize", params={"key": key}, json={"text": "Hello"})
    assert spoken.status_code == 401
    assert spoken.json()["code"] == "missing_api_key"
    # The same key in the header is still accepted.
    in_header = await client.get(f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": key})
    assert in_header.status_code == 200


async def test_embed_invalid_key(client):
    _, _, avatar_id, _ = await _setup(client)
    response = await client.get(f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": "lf_wrong"})
    assert response.status_code == 401


async def test_revoked_key_rejected(client):
    headers, org_id, avatar_id, created = await _setup(client)
    await client.delete(f"/orgs/{org_id}/api-keys/{created['api_key']['id']}", headers=headers)
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": created["plaintext"]}
    )
    assert response.status_code == 401


async def test_origin_check_blocks_unlisted_domain(client):
    _, _, avatar_id, created = await _setup(client, allowed_domains=["example.com"])
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"], "Origin": "https://evil.com"},
    )
    assert response.status_code == 403
    assert response.json()["code"] == "origin_not_allowed"


async def test_origin_check_allows_listed_domain(client):
    _, _, avatar_id, created = await _setup(client, allowed_domains=["example.com"])
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"], "Origin": "https://example.com"},
    )
    assert response.status_code == 200


async def test_origin_check_wildcard_subdomains(client):
    _, _, avatar_id, created = await _setup(client, allowed_domains=["*.example.com"])
    ok = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"], "Origin": "https://app.example.com"},
    )
    assert ok.status_code == 200
    bad = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"], "Origin": "https://example.org"},
    )
    assert bad.status_code == 403


async def test_embed_synthesize(client):
    _, _, _, created = await _setup(client)
    response = await client.post(
        "/embed/v1/synthesize",
        json={"text": "Hi there", "provider": "offline", "voice": "offline-warm"},
        headers={"X-Api-Key": created["plaintext"]},
    )
    assert response.status_code == 200
    assert response.json()["cues"]


async def test_embed_rate_limit(client):
    # conftest sets the embed limit to 5/minute.
    _, _, avatar_id, created = await _setup(client)
    key_headers = {"X-Api-Key": created["plaintext"]}
    statuses = []
    for _ in range(7):
        response = await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key_headers)
        statuses.append(response.status_code)
    assert statuses.count(429) >= 2
    assert response.json()["code"] == "rate_limited"


async def test_embed_cors_reflects_origin(client):
    _, _, avatar_id, created = await _setup(client)
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"], "Origin": "https://anyhost.example"},
    )
    assert response.headers["access-control-allow-origin"] == "https://anyhost.example"


async def test_embed_preflight_options(client):
    response = await client.options(
        "/embed/v1/synthesize",
        headers={
            "Origin": "https://host.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert response.status_code == 204
    assert response.headers["access-control-allow-origin"] == "https://host.example"
    assert "X-Api-Key" in response.headers["access-control-allow-headers"]


async def test_member_cannot_manage_api_keys(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    invite = await client.post(
        f"/orgs/{org_id}/invitations",
        json={"email": "bob@example.com"},
        headers=alice,
    )
    bob = await register_and_login(client, "bob")
    await client.post(f"/invitations/{invite.json()['token']}/accept", headers=bob)
    response = await client.post(f"/orgs/{org_id}/api-keys", json={"name": "nope"}, headers=bob)
    assert response.status_code == 403


async def test_cues_endpoint_is_public_and_timed(client) -> None:
    """The browser voice fetches this without a key — it synthesises nothing."""
    response = await client.post("/embed/v1/cues", json={"text": "Hello world."})
    assert response.status_code == 200
    body = response.json()

    assert body["duration_ms"] > 0
    assert body["cues"][-1]["viseme"] == "sil"
    assert all(b["t"] > a["t"] for a, b in zip(body["cues"], body["cues"][1:]))
    assert [m["char"] for m in body["word_marks"]] == [0, 6]


async def test_cues_endpoint_rejects_empty_text(client) -> None:
    assert (await client.post("/embed/v1/cues", json={"text": ""})).status_code == 422


async def test_simulator_tokens_share_the_embed_rate_limit(client):
    """Origin binding does not stop a client that forges Origin, so the
    per-minute limit is what bounds a minted token."""
    headers = await register_and_login(client, "simlimit")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    origin = {"origin": "http://testserver"}
    minted = await client.post(
        f"/orgs/{org_id}/api-keys/simulator-token", headers={**headers, **origin}
    )
    token = minted.json()["token"]
    statuses = []
    for _ in range(7):  # conftest sets the embed limit to 5/minute
        response = await client.get(
            f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": token, **origin}
        )
        statuses.append(response.status_code)
    assert statuses.count(200) == 5
    assert statuses.count(429) == 2
    assert response.json()["code"] == "rate_limited"
    assert "retry-after" in response.headers


async def test_last_used_is_written_at_most_every_few_minutes(client):
    """A commit per embed request was a SQLite write on the hottest path."""
    headers, org_id, avatar_id, created = await _setup(client)
    key_headers = {"X-Api-Key": created["plaintext"]}

    async def last_used():
        listing = (await client.get(f"/orgs/{org_id}/api-keys", headers=headers)).json()
        return listing[0]["last_used_at"]

    assert await last_used() is None
    await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key_headers)
    first = await last_used()
    assert first is not None
    await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key_headers)
    assert await last_used() == first


async def test_last_used_moves_once_it_is_stale():
    class Session:
        commits = 0

        async def commit(self):
            self.commits += 1

    db = Session()
    key = ApiKey(org_id="o", name="k", prefix="lf_x", key_hash="h", allowed_domains="")
    key.last_used_at = (utcnow() - timedelta(minutes=6)).replace(tzinfo=None)
    await api_keys.mark_used(db, key)  # type: ignore[arg-type]
    assert db.commits == 1
    await api_keys.mark_used(db, key)  # type: ignore[arg-type]
    assert db.commits == 1


async def test_cues_text_is_capped(client) -> None:
    response = await client.post("/embed/v1/cues", json={"text": "a" * 5001})
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


async def test_cues_are_rate_limited_per_client(client, monkeypatch) -> None:
    """Unauthenticated, so the client address is what is counted."""
    monkeypatch.setattr(embed, "CUES_PER_CLIENT", Limit("cues-test", 3, 60))
    statuses = [
        (await client.post("/embed/v1/cues", json={"text": "Hello."})).status_code for _ in range(4)
    ]
    assert statuses == [200, 200, 200, 429]
    refused = await client.post("/embed/v1/cues", json={"text": "Hello."})
    assert refused.json()["code"] == "rate_limited"
    assert 1 <= int(refused.headers["retry-after"]) <= 60


async def test_cues_answer_is_byte_for_byte_what_fastapi_rendered(client) -> None:
    """Serialised on the planning thread now; the bytes must not change."""
    text = "Bonjour, tout le monde! L'économie va bien."
    response = await client.post("/embed/v1/cues", json={"text": text, "locale": "fr-FR"})
    cues, duration_ms, marks = timing.cue_track(text, "fr-FR")
    model = embed.CueResponse(
        cues=[CueOut(**c) for c in cues],
        duration_ms=duration_ms,
        word_marks=[embed.WordMark(**m) for m in marks],
    )
    # What FastAPI's JSONResponse does with a response_model's output.
    rendered = json.dumps(
        model.model_dump(mode="json"), ensure_ascii=False, allow_nan=False, separators=(",", ":")
    ).encode()
    assert response.content == rendered
    assert response.headers["content-type"] == "application/json"


async def test_cues_are_planned_off_the_event_loop(client, monkeypatch) -> None:
    """Outside English, planning waits on espeak-ng: on the loop, that wait
    stalls every other widget the process serves."""
    real = timing.plan_utterance
    threads = []

    def spy(text, locale="en-US"):
        threads.append(threading.current_thread())
        return real(text, locale)

    monkeypatch.setattr(timing, "plan_utterance", spy)
    response = await client.post("/embed/v1/cues", json={"text": "Bonjour.", "locale": "fr-FR"})
    assert response.status_code == 200
    assert threads and threads[0] is not threading.main_thread()


# --- Opaque origins (Origin: null) ----------------------------------------------
#
# A sandboxed frame (no allow-same-origin), a data: page or a file: page sends
# `Origin: null`. Any website can make one, so it vouches for no domain: taken
# as "not a browser", it let any site use a key locked to someone's domain.


async def test_a_domain_locked_key_is_refused_from_an_opaque_origin(client):
    _, _, avatar_id, created = await _setup(client, allowed_domains=["example.com"])
    key = {"X-Api-Key": created["plaintext"]}
    for origin in (
        {"Origin": "null"},
        # The allowed domain in Referer changes nothing: Origin says null.
        {"Origin": "null", "Referer": "https://example.com/page"},
    ):
        response = await client.get(f"/embed/v1/avatars/{avatar_id}", headers={**key, **origin})
        assert response.status_code == 403
        assert response.json()["code"] == "origin_not_allowed"
    speak = await client.post(
        "/embed/v1/synthesize",
        json={"text": "Hi", "provider": "offline", "voice": "offline-warm"},
        headers={**key, "Origin": "null"},
    )
    assert speak.status_code == 403
    assert speak.json()["code"] == "origin_not_allowed"


async def test_a_domain_locked_key_still_works_from_its_domain(client):
    _, _, avatar_id, created = await _setup(client, allowed_domains=["example.com"])
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"], "Origin": "https://example.com"},
    )
    assert response.status_code == 200


async def test_a_key_without_domains_works_from_an_opaque_origin(client):
    _, _, avatar_id, created = await _setup(client)
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"], "Origin": "null"},
    )
    assert response.status_code == 200


async def test_a_simulator_token_works_from_the_sandboxed_simulator_frame(client):
    """The Simulator's frame is sandboxed without allow-same-origin, so the
    widget inside it sends Origin: null with a token minted on the
    dashboard's own origin."""
    headers = await register_and_login(client, "sandboxed")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    minted = await client.post(
        f"/orgs/{org_id}/api-keys/simulator-token",
        headers={**headers, "origin": "http://testserver"},
    )
    assert minted.status_code == 200, minted.text
    token = minted.json()["token"]
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": token, "Origin": "null"}
    )
    assert response.status_code == 200, response.text
    # A page that names a host is still held to the one it was minted for.
    elsewhere = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": token, "Origin": "https://evil.example.net"},
    )
    assert elsewhere.status_code == 401
    assert elsewhere.json()["code"] == "simulator_token_invalid"


async def test_a_cloned_line_never_rendered_is_a_refusal_with_its_code(client, monkeypatch):
    """The widget's own path, outside any stream: the API's envelope, so an
    integrator can branch on the code."""
    from app.services.tts import cloned

    unavailable = {"available": False, "device": None, "reason": "no accelerator"}
    monkeypatch.setattr(cloned, "capability", lambda: unavailable)
    _, org_id, _, created = await _setup(client)
    response = await client.post(
        "/embed/v1/synthesize",
        json={"text": "Never rendered", "provider": "cloned", "voice": f"{org_id}:sarah"},
        headers={"X-Api-Key": created["plaintext"]},
    )
    assert response.status_code == 404
    assert response.json()["code"] == "cloned_line_missing"
    assert org_id not in response.text
