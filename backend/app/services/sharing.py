"""
app/services/sharing.py
Cryptographically secure share ID generation and share URL helpers.
Share IDs must never be predictable/sequential — we use
secrets.token_urlsafe, which draws from os.urandom.
"""
import secrets

from app.config import get_settings

settings = get_settings()

SHARE_ID_BYTES = 9  # ~12 url-safe base64 characters — plenty of entropy for an MVP


def generate_share_id() -> str:
    return secrets.token_urlsafe(SHARE_ID_BYTES)


def build_share_url(share_id: str) -> str:
    return f"{settings.effective_public_base_url}/s/{share_id}"
