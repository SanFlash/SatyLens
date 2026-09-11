"""
app/services/sharing.py
Cryptographically secure share ID generation and share URL helpers.
Share IDs must never be predictable/sequential — we use
secrets.token_urlsafe, which draws from os.urandom.
"""
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.config import get_settings

settings = get_settings()

SHARE_ID_BYTES = 9  # ~12 url-safe base64 characters — plenty of entropy for an MVP


def generate_share_id() -> str:
    return secrets.token_urlsafe(SHARE_ID_BYTES)


def build_share_url(share_id: str) -> str:
    return f"{settings.effective_public_base_url}/s/{share_id}"


def compute_default_expiry() -> Optional[str]:
    """ISO timestamp for DEFAULT_SHARE_EXPIRY_DAYS from now, or None if
    that policy isn't set. Applied automatically at upload time for
    every new share (both the Supabase backend and R2 destinations) --
    an org-wide retention default an admin sets once via the backend's
    environment, not something each user opts into per share. A share's
    expiration can still be shortened afterward (never removed/extended
    past the policy) via POST /api/media/{id}/expire."""
    if settings.DEFAULT_SHARE_EXPIRY_DAYS <= 0:
        return None
    return (datetime.now(timezone.utc) + timedelta(days=settings.DEFAULT_SHARE_EXPIRY_DAYS)).isoformat()
