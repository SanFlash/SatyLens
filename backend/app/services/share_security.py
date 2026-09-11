"""
app/services/share_security.py
Password hashing and short-lived download-token signing for
password-protected share links. Stdlib only (hashlib/hmac/secrets) --
no new dependency for what's fundamentally a small amount of crypto.

Design: since this backend has no session/cookie/user-auth system
anywhere else, password-protected shares work statelessly:
  1. GET /s/{id} on a password-protected share renders a password form.
  2. POST /s/{id} with the password renders the actual content directly
     on success (no redirect needed) -- and the page's own Download
     link/button embeds a short-lived signed token (via
     generate_download_token) instead of asking for the password again.
  3. GET /s/{id}/download requires either that token or a submitted
     password -- see app/routes/share.py.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time

_PBKDF2_ITERATIONS = 260_000
_PBKDF2_ALGO = "sha256"
_TOKEN_TTL_SECONDS = 600  # 10 minutes -- long enough for one viewing session


def hash_password(password: str) -> str:
    """Returns "salt_hex$hash_hex", suitable for storing in the
    captures.password_hash column."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(_PBKDF2_ALGO, password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt_hex, digest_hex = stored_hash.split("$", 1)
    except ValueError:
        return False
    salt = bytes.fromhex(salt_hex)
    expected = bytes.fromhex(digest_hex)
    actual = hashlib.pbkdf2_hmac(_PBKDF2_ALGO, password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return hmac.compare_digest(actual, expected)


def generate_download_token(share_id: str, secret: str, ttl_seconds: int = _TOKEN_TTL_SECONDS) -> str:
    """A short-lived, tamper-proof token proving "the password for this
    share was verified recently" -- avoids needing session/cookie state
    while still not requiring the password on every single click within
    one viewing session (e.g. clicking Download right after unlocking
    the page)."""
    expires_at = int(time.time()) + ttl_seconds
    payload = f"{share_id}:{expires_at}"
    signature = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{expires_at}.{signature}"


def verify_download_token(share_id: str, token: str, secret: str) -> bool:
    try:
        expires_str, signature = token.split(".", 1)
        expires_at = int(expires_str)
    except (ValueError, AttributeError):
        return False
    if time.time() > expires_at:
        return False
    payload = f"{share_id}:{expires_at}"
    expected_signature = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected_signature)
