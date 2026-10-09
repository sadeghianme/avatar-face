import math

import pytest

from app.services.tts.lab_timing import PhoneSpan, native_cues
from tests.conftest import create_org, register_and_login


def test_native_timestamps_not_retimed_to_total_length():
    cues = native_cues([PhoneSpan("p", 0.12, 0.18), PhoneSpan("a", 0.18, 0.42)], 2000, b"")
    assert next(c["t"] for c in cues if c["viseme"] == "PP") == 120
    assert next(c["t"] for c in cues if c["viseme"] == "aa") == 180
    assert {"t": 420, "viseme": "sil", "a": 1.0} in cues
    assert cues[-1]["t"] == 2000


def test_native_gaps_and_affricates_survive():
    cues = native_cues(
        [PhoneSpan("t", 0, 0.04), PhoneSpan("ʃ", 0.04, 0.12), PhoneSpan("u", 0.4, 0.8)], 900, b""
    )
    assert cues[0]["viseme"] == "CH"
    assert next(c["t"] for c in cues if c["viseme"] == "sil") == 120
    assert next(c["t"] for c in cues if c["viseme"] == "ou") == 400


def test_stress_and_length_tokens_do_not_invent_silence():
    cues = native_cues(
        [
            PhoneSpan("ˈ", 0, 0.03),
            PhoneSpan("i", 0.03, 0.1),
            PhoneSpan("ː", 0.1, 0.15),
            PhoneSpan("ɚ", 0.15, 0.3),
        ],
        500,
        b"",
    )
    assert cues[0]["viseme"] == "ih"
    assert next(c["t"] for c in cues if c["viseme"] == "sil") == 300


@pytest.mark.parametrize(
    "spans",
    [
        [],
        [PhoneSpan("a", -1, 0)],
        [PhoneSpan("a", 0, math.nan)],
        [PhoneSpan("a", 0.2, 0.1)],
        [PhoneSpan("a", 0, 2)],
        [PhoneSpan("a", 0, 0.5), PhoneSpan("p", 0.3, 0.6)],
        [PhoneSpan("Ж", 0, 0.2)],
    ],
)
def test_invalid_or_unmapped_timing_is_not_called_native(spans):
    with pytest.raises(ValueError):
        native_cues(spans, 1000, b"")


async def test_lab_endpoint_requires_membership(client):
    headers = await register_and_login(client)
    org = await create_org(client, headers)
    other = await register_and_login(client, "bob")
    path = f"/orgs/{org}/lab/lip-sync/synthesize"
    assert (await client.post(path, json={"text": "Hello"})).status_code == 401
    assert (await client.post(path, json={"text": "Hello"}, headers=other)).status_code in (
        403,
        404,
    )


async def test_lab_fallback_is_labeled_and_does_not_claim_alignment(client, monkeypatch):
    monkeypatch.setattr("app.services.tts.lab_timing.configured", lambda: False)
    headers = await register_and_login(client)
    org = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org}/lab/lip-sync/synthesize",
        headers=headers,
        json={"text": "Mama bought a bag.", "provider": "offline", "voice": "offline-warm"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["timing_source"] == "existing_provider"
    assert payload["cues"] == payload["baseline_cues"]


async def test_native_path_returns_one_audio_and_two_tracks(client, monkeypatch):
    monkeypatch.setattr("app.services.tts.lab_timing.configured", lambda: True)

    async def fake(text, voice):
        return (
            b"RIFF",
            1000,
            [{"t": 0, "viseme": "PP"}, {"t": 1000, "viseme": "sil"}],
            [{"t": 0, "viseme": "aa"}],
        )

    monkeypatch.setattr("app.services.tts.lab_timing.synthesize_native", fake)
    headers = await register_and_login(client)
    org = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org}/lab/lip-sync/synthesize", headers=headers, json={"text": "Mama"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["timing_source"] == "native_phonemes"
    assert response.json()["cues"] != response.json()["baseline_cues"]
    assert response.json()["cached"] is False


async def test_native_failure_is_explicit_and_does_not_silently_fallback(client, monkeypatch):
    monkeypatch.setattr("app.services.tts.lab_timing.configured", lambda: True)

    async def fail(text, voice):
        raise ValueError("invalid timestamps")

    monkeypatch.setattr("app.services.tts.lab_timing.synthesize_native", fail)
    headers = await register_and_login(client)
    org = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org}/lab/lip-sync/synthesize", headers=headers, json={"text": "Mama"}
    )
    assert response.status_code == 422
    assert response.json()["code"] == "native_timing_unavailable"


async def test_lab_rejects_browser_voice_and_oversized_script(client):
    headers = await register_and_login(client)
    org = await create_org(client, headers)
    path = f"/orgs/{org}/lab/lip-sync/synthesize"
    for body in ({"text": "Hello", "provider": "browser"}, {"text": "x" * 601}, {"text": "   "}):
        assert (await client.post(path, json=body, headers=headers)).status_code == 422


async def test_lab_native_speech_obeys_usage_limits(client, monkeypatch):
    monkeypatch.setattr("app.services.tts.lab_timing.configured", lambda: True)

    async def fake(text, voice):
        return b"RIFF", 1000, [{"t": 0, "viseme": "PP"}], [{"t": 0, "viseme": "aa"}]

    monkeypatch.setattr("app.services.tts.lab_timing.synthesize_native", fake)
    headers = await register_and_login(client)
    org = await create_org(client, headers)
    path = f"/orgs/{org}/lab/lip-sync/synthesize"
    assert (
        await client.post(path, headers=headers, json={"text": "hello " * 100})
    ).status_code == 200
    assert (
        await client.post(path, headers=headers, json={"text": "hello " * 100})
    ).status_code == 429
