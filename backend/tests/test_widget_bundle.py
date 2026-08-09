"""The embed bundle's cache policy.

The URL is baked into every customer's pasted snippet, so it can never be
versioned with a content hash the way a normal asset is. Revalidation is the
only mechanism that lets a fix reach visitors promptly, which makes these
headers load-bearing rather than incidental.
"""


async def test_widget_bundle_revalidates(client):
    response = await client.get("/liveface.js")
    # 404 when the bundle is not built in this checkout; the header contract
    # is what is under test either way.
    cache = response.headers["cache-control"]
    assert "no-cache" in cache, cache
    # no-store would defeat the point: it forbids keeping a copy at all, so
    # every page load re-downloads the whole bundle instead of sending a
    # conditional request and getting a 304.
    assert "no-store" not in cache, cache


async def test_widget_bundle_is_cross_origin_readable(client):
    """It runs on customers' domains, so it must be fetchable from anywhere."""
    response = await client.get("/liveface.js")
    assert response.headers["access-control-allow-origin"] == "*"


async def test_3d_bundle_shares_the_policy(client):
    response = await client.get("/liveface-3d.js")
    assert "no-cache" in response.headers["cache-control"]


async def test_marked_private_so_cloudflare_leaves_the_header_alone(client):
    """Cloudflare's Browser Cache TTL rewrites no-cache to max-age=14400.

    Measured against the live edge: without `private` it substitutes its own
    four-hour max-age, which is the whole problem this policy exists to fix.
    """
    response = await client.get("/liveface.js")
    assert "private" in response.headers["cache-control"]


async def test_revalidation_returns_304_not_the_whole_bundle(client):
    """`no-cache` is only cheap if conditional requests actually short-circuit.

    A bare FileResponse ignores If-None-Match and answers 200 with the full
    body, which would turn every page load into a re-download.
    """
    first = await client.get("/liveface.js")
    if first.status_code == 404:
        return  # bundle not built in this checkout
    etag = first.headers["etag"]

    again = await client.get("/liveface.js", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert not again.content


async def test_revalidation_survives_a_proxy_reencoding_the_tag(client):
    """Caddy and Cloudflare append `-gzip` when they recompress the body.

    Comparing tags literally would never match through the proxy, so every
    revalidation would quietly fall back to a full 200 in production while
    passing a naive test locally.
    """
    first = await client.get("/liveface.js")
    if first.status_code == 404:
        return
    proxied = f'W/{first.headers["etag"][:-1]}-gzip"'

    again = await client.get("/liveface.js", headers={"If-None-Match": proxied})
    assert again.status_code == 304, f"{proxied} should have matched"


async def test_a_changed_bundle_is_not_reported_unchanged(client):
    """The mirror image: a stale tag must return the new body, not a 304."""
    first = await client.get("/liveface.js")
    if first.status_code == 404:
        return
    again = await client.get("/liveface.js", headers={"If-None-Match": '"stale"'})
    assert again.status_code == 200
    assert again.content


def test_etag_normalisation_rules():
    from app.main import _etag_matches

    assert _etag_matches('"abc"', '"abc"')
    assert _etag_matches('W/"abc"', '"abc"')
    assert _etag_matches('W/"abc-gzip"', '"abc"')
    assert _etag_matches('"other", W/"abc-br"', '"abc"')
    assert _etag_matches("*", '"abc"')
    assert not _etag_matches('"abc"', '"abd"')
    assert not _etag_matches(None, '"abc"')
    assert not _etag_matches("", '"abc"')
