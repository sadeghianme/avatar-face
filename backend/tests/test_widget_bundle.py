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
