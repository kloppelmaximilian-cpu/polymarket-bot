"""TLS trust store for outbound connections.

Python does not have one trust store, it has two paths to one, and they
disagree on macOS. `httpx` verifies against `certifi`'s bundle, which ships
inside the wheel. `websockets` calls :func:`ssl.create_default_context`, which
reads OpenSSL's compiled-in paths -- and on a python.org macOS build those
point into the framework directory, empty until someone runs
`Install Certificates.command`.

The failure that produces is genuinely confusing, because it is partial: REST
discovery works, every websocket dies with `unable to get local issuer
certificate`, and the bot looks like it cannot reach exchanges it is in fact
already talking to over HTTPS.

So websocket connections get the same bundle the HTTP client uses. An operator
behind a TLS-inspecting proxy can point both at their own CA through the
standard `SSL_CERT_FILE`, or `PMBOT_CA_BUNDLE` when only this process should
trust it.
"""

from __future__ import annotations

import os
import ssl
from functools import lru_cache

from ..logging_setup import get_logger

log = get_logger("pmbot.tls")

#: Checked in order. The first one set wins, so a deliberate override always
#: beats the bundled default.
CA_BUNDLE_ENV_VARS = ("PMBOT_CA_BUNDLE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE")


def ca_bundle_path() -> str | None:
    """The CA bundle to verify against, or ``None`` for OpenSSL's own paths."""
    for name in CA_BUNDLE_ENV_VARS:
        value = os.environ.get(name)
        if not value:
            continue
        if os.path.exists(value):
            return value
        log.warning(
            "ignoring CA bundle override: file does not exist",
            extra={"env": name, "path": value},
        )
    try:
        import certifi
    except ImportError:          # pragma: no cover - certifi ships with httpx
        return None
    return certifi.where()


@lru_cache(maxsize=4)
def _context_for(bundle: str | None) -> ssl.SSLContext:
    # Parsing a 250KB PEM per reconnect would be wasteful, and reconnects are
    # exactly when this runs.
    if bundle is None:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=bundle)


def ssl_context_for(url: str) -> ssl.SSLContext | None:
    """A verifying context for ``wss://``; ``None`` for plaintext ``ws://``.

    ``websockets`` rejects an ``ssl`` argument on a ``ws://`` URI, and the test
    suite connects to local plaintext fakes, so the scheme decides.
    """
    if not url.lower().startswith("wss://"):
        return None
    return _context_for(ca_bundle_path())


def trust_store_summary() -> tuple[str, str]:
    """``(source, detail)`` for `bot doctor`, without opening a connection."""
    for name in CA_BUNDLE_ENV_VARS:
        value = os.environ.get(name)
        if value and os.path.exists(value):
            return name, value
    bundle = ca_bundle_path()
    if bundle is None:
        paths = ssl.get_default_verify_paths()
        return "openssl", str(paths.cafile or paths.capath or "none found")
    return "certifi", bundle


def tls_kwargs(url: str) -> dict[str, ssl.SSLContext]:
    """``websockets.connect`` keyword arguments for this URL.

    Empty for ``ws://``, where passing ``ssl`` at all is an error.
    """
    context = ssl_context_for(url)
    return {"ssl": context} if context is not None else {}
