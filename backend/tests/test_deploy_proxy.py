"""Production runs behind Caddy: the visitor's address must survive it.

Uvicorn trusts X-Forwarded-For only from FORWARDED_ALLOW_IPS (127.0.0.1 by
default). Behind a proxy on a docker network every request comes from the
proxy's container, so without the setting every consent's address hash and
every share-page rate-limit key would be the proxy's. These tests read the
production compose file and run uvicorn's own middleware with its value.
"""

from pathlib import Path

import yaml
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

COMPOSE = Path(__file__).resolve().parents[2] / "deploy" / "docker-compose.prod.yml"


def _trusted() -> str:
    services = yaml.safe_load(COMPOSE.read_text())["services"]
    return services["liveface-api"]["environment"]["FORWARDED_ALLOW_IPS"]


async def _client_seen(peer: str, forwarded: str | None) -> str:
    seen: dict = {}

    async def app(scope, receive, send):
        seen["client"] = scope["client"][0]

    headers = [(b"x-forwarded-for", forwarded.encode())] if forwarded else []
    scope = {
        "type": "http", "scheme": "http", "client": (peer, 40000), "headers": headers,
        "path": "/", "method": "GET",
    }
    await ProxyHeadersMiddleware(app, trusted_hosts=_trusted())(scope, None, None)
    return seen["client"]


async def test_the_visitors_address_comes_through_the_proxy():
    # Caddy on the docker network, forwarding a visitor.
    assert await _client_seen("172.18.0.3", "203.0.113.9") == "203.0.113.9"


async def test_nobody_outside_the_proxy_network_can_claim_an_address():
    assert await _client_seen("198.51.100.7", "203.0.113.9") == "198.51.100.7"
