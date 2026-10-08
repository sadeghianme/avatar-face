"""Production runs behind Cloudflare and Caddy: the visitor's address must
survive both, and nobody else's claim may pass for it.

These tests read the production compose file and the API's Dockerfile, and
run core.client_ip with exactly the settings production gives it.
"""

import ipaddress
from pathlib import Path

import yaml

from app.core.client_ip import ProxyPolicy, resolve
from app.core.cloudflare_ranges import CLOUDFLARE_RANGES

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "deploy" / "docker-compose.prod.yml"
DOCKERFILE = ROOT / "backend" / "Dockerfile"


def _environment() -> dict[str, str]:
    services = yaml.safe_load(COMPOSE.read_text())["services"]
    return services["liveface-api"]["environment"]


def _policy() -> ProxyPolicy:
    env = _environment()
    return ProxyPolicy(
        proxies=tuple(ipaddress.ip_network(c) for c in env["TRUSTED_PROXIES"].split(",")),
        hops=int(env["TRUSTED_PROXY_HOPS"]),
        cloudflare=(
            tuple(ipaddress.ip_network(c) for c in CLOUDFLARE_RANGES)
            if env["TRUST_CLOUDFLARE"] == "true"
            else ()
        ),
    )


def test_the_visitor_comes_through_cloudflare_and_caddy():
    # Caddy on the docker network, forwarding what a Cloudflare edge sent.
    assert resolve("172.18.0.3", "162.158.1.2", "203.0.113.9", _policy()) == "203.0.113.9"


def test_nobody_outside_the_proxy_network_can_claim_an_address():
    assert resolve("198.51.100.7", "203.0.113.9", "203.0.113.9", _policy()) == "198.51.100.7"


def test_reaching_caddy_without_cloudflare_cannot_claim_an_address():
    assert resolve("172.18.0.3", "198.51.100.7", "203.0.113.9", _policy()) == "198.51.100.7"


def test_uvicorn_leaves_the_peer_alone():
    """If uvicorn rewrote the peer from X-Forwarded-For, the walk would start
    from Cloudflare's edge and the docker hop could not be checked."""
    assert '"--no-proxy-headers"' in DOCKERFILE.read_text()
    assert "FORWARDED_ALLOW_IPS" not in _environment()
