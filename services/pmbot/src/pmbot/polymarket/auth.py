"""Polymarket CLOB authentication headers.

Implemented directly against the documented scheme (and cross-checked against
the official client) so the hot path has no heavyweight dependency:

* **L1** -- EIP-712 signature over the ``ClobAuth`` struct.  Needs a private
  key, so it is delegated to the official client when one is available.
* **L2** -- HMAC-SHA256 over ``timestamp + method + path + body`` with the
  base64url-decoded API secret.  Pure stdlib.

The body used for the signature must be the *exact* bytes that are sent, which
is why :func:`l2_headers` takes the already-serialised string.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from dataclasses import dataclass

POLY_ADDRESS = "POLY_ADDRESS"
POLY_SIGNATURE = "POLY_SIGNATURE"
POLY_TIMESTAMP = "POLY_TIMESTAMP"
POLY_NONCE = "POLY_NONCE"
POLY_API_KEY = "POLY_API_KEY"
POLY_PASSPHRASE = "POLY_PASSPHRASE"


@dataclass(frozen=True, slots=True)
class ApiCreds:
    api_key: str
    api_secret: str
    api_passphrase: str

    def __repr__(self) -> str:      # never leak secrets into a traceback
        return f"ApiCreds(api_key={self.api_key[:6]}..., secret=***, passphrase=***)"


def build_hmac_signature(
    secret: str, timestamp: int | str, method: str, request_path: str, body: str | None = None
) -> str:
    """base64url(HMAC-SHA256(base64url_decode(secret), ts+method+path+body))."""
    decoded = base64.urlsafe_b64decode(secret)
    message = f"{timestamp}{method}{request_path}"
    if body:
        # The reference implementations sign the JS/Go object rendering, which
        # uses double quotes; a Python dict repr would produce single quotes.
        message += str(body).replace("'", '"')
    digest = hmac.new(decoded, message.encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("utf-8")


def l2_headers(
    address: str,
    creds: ApiCreds,
    method: str,
    request_path: str,
    body: str | None = None,
    timestamp: int | None = None,
) -> dict[str, str]:
    ts = int(time.time()) if timestamp is None else int(timestamp)
    return {
        POLY_ADDRESS: address,
        POLY_SIGNATURE: build_hmac_signature(
            creds.api_secret, ts, method.upper(), request_path, body
        ),
        POLY_TIMESTAMP: str(ts),
        POLY_API_KEY: creds.api_key,
        POLY_PASSPHRASE: creds.api_passphrase,
    }


def ws_auth_payload(creds: ApiCreds) -> dict[str, str]:
    """Auth block for the CLOB user websocket channel."""
    return {
        "apiKey": creds.api_key,
        "secret": creds.api_secret,
        "passphrase": creds.api_passphrase,
    }
