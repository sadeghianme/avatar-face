"""The address of the client a request came from, through trusted proxies.

Production is Cloudflare -> Caddy -> this API. The TCP peer is Caddy's
container; Caddy writes the address IT saw (a Cloudflare edge) into
X-Forwarded-For, replacing whatever the client sent; Cloudflare puts the
visitor in CF-Connecting-IP. Keyed on the peer, every per-client rate limit
was one bucket for the whole internet; keyed on X-Forwarded-For, it was one
bucket per Cloudflare edge, which thousands of visitors share. Keyed on a
header anyone can send, it would be no limit at all.

So the walk starts at the peer, the one address nobody can forge, and moves
outward one hop at a time, only while the hop it stands on is trusted:

* a configured proxy (TRUSTED_PROXIES: the docker network Caddy is on) vouches
  for the X-Forwarded-For entry it appended, the rightmost one; at most
  TRUSTED_PROXY_HOPS entries are taken this way;
* a Cloudflare edge (TRUST_CLOUDFLARE, the published ranges pinned in
  core.cloudflare_ranges) vouches for CF-Connecting-IP, and the walk ends.

The first address that is neither is the client. A header sent by a client
that is not standing behind one of those is never read, so a visitor who
reaches the origin directly with a forged CF-Connecting-IP is keyed on their
own address. Uvicorn's own X-Forwarded-For handling is off (--no-proxy-headers,
backend/Dockerfile): this module is the only reader of these headers.

With nothing configured (development, tests) the client is the peer.
"""

from __future__ import annotations

import ipaddress
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache

from starlette.requests import Request

from app.core.cloudflare_ranges import CLOUDFLARE_RANGES
from app.core.config import get_settings

type IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
type IPNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network

UNKNOWN = "unknown"


@dataclass(frozen=True)
class ProxyPolicy:
    """Whom to believe: the proxies' networks, how many X-Forwarded-For
    entries they may vouch for, and Cloudflare's edge (or nothing)."""

    proxies: tuple[IPNetwork, ...] = ()
    hops: int = 1
    cloudflare: tuple[IPNetwork, ...] = ()


def parse_address(value: str | None) -> IPAddress | None:
    """An address as a header or a peer gives it, or None.

    Accepts a bare address, `[v6]` and `[v6]:port`, `v4:port`, and unwraps
    an IPv4-mapped IPv6 address (`::ffff:203.0.113.9`) to the IPv4 one, so
    the same visitor is one key whichever stack reported them.
    """
    if not value:
        return None
    text = value.strip()
    if text.startswith("["):
        text = text[1 : text.find("]")] if "]" in text else ""
    elif text.count(":") == 1:  # v4:port; a bare v6 has several colons
        text = text.split(":", 1)[0]
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def _within(address: IPAddress, networks: Iterable[IPNetwork]) -> bool:
    return any(address in network for network in networks)


def resolve(
    peer: str | None,
    forwarded_for: str | None,
    cf_connecting_ip: str | None,
    policy: ProxyPolicy,
) -> str:
    """The client's address for a request from `peer` with these headers.

    `peer` comes back as given when it is not an address at all (a test
    transport's "testclient"), and "unknown" when there is none.
    """
    address = parse_address(peer)
    if address is None:
        return peer or UNKNOWN
    # Rightmost last: entries are popped from the proxy's end.
    chain = [entry for entry in (forwarded_for or "").split(",") if entry.strip()]
    hops = policy.hops
    while True:
        if policy.cloudflare and _within(address, policy.cloudflare):
            visitor = parse_address(cf_connecting_ip)
            return str(visitor if visitor is not None else address)
        if hops > 0 and chain and _within(address, policy.proxies):
            vouched = parse_address(chain.pop())
            if vouched is None:
                # A proxy we trust wrote something that is not an address:
                # stop at the last hop we can name rather than guess.
                return str(address)
            address = vouched
            hops -= 1
            continue
        return str(address)


@lru_cache(maxsize=8)
def _policy(proxies: tuple[str, ...], hops: int, cloudflare: bool) -> ProxyPolicy:
    return ProxyPolicy(
        proxies=tuple(ipaddress.ip_network(cidr, strict=False) for cidr in proxies),
        hops=max(0, hops),
        cloudflare=(
            tuple(ipaddress.ip_network(cidr) for cidr in CLOUDFLARE_RANGES) if cloudflare else ()
        ),
    )


def current_policy() -> ProxyPolicy:
    """The policy the settings describe (TRUSTED_PROXIES, TRUSTED_PROXY_HOPS,
    TRUST_CLOUDFLARE), parsed once per distinct value."""
    settings = get_settings()
    return _policy(
        tuple(settings.trusted_proxies), settings.trusted_proxy_hops, settings.trust_cloudflare
    )


def client_ip(request: Request) -> str:
    """The client's address: what every per-client rate limit is keyed on,
    and what anything that records or logs a client address must use."""
    return resolve(
        request.client.host if request.client else None,
        # Several X-Forwarded-For lines are one list (RFC 9110, 5.3).
        ",".join(request.headers.getlist("x-forwarded-for")),
        request.headers.get("cf-connecting-ip"),
        current_policy(),
    )
