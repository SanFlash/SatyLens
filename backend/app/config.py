"""
app/config.py
Centralized settings loaded from environment variables (.env in dev).
Never hardcode secrets here -- everything sensitive comes from the
environment so it can be injected safely by the deployment platform
(Render, Railway, etc.) without touching source control.
"""
import os
import secrets
from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict

_DEFAULT_PUBLIC_BASE_URL = "http://localhost:8000"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    SUPABASE_URL: str = ""
    SUPABASE_SERVICE_ROLE_KEY: str = ""
    SUPABASE_BUCKET: str = "captures"

    PUBLIC_BASE_URL: str = _DEFAULT_PUBLIC_BASE_URL
    MAX_FILE_SIZE_MB: int = 0  # 0 = no cap (see max_file_size_bytes below); set a positive value to re-enable one

    EXTRA_CORS_ORIGINS: str = ""
    ALLOWED_EXTENSION_ORIGINS: str = ""

    # Optional shared token gating the /api/analytics/* reporting endpoints
    # (dashboard + drill-down views). Leave unset for fully open access
    # during local development; set it before deploying anywhere public.
    # Ingestion endpoints (/api/events, /api/session/*) never needs this.
    ANALYTICS_DASHBOARD_TOKEN: str = ""

    # Cloudflare R2 (S3-compatible). All optional -- the "r2" upload
    # destination simply stays unavailable (clean 503) until these are set.
    # Never put the secret key anywhere but here / the host's env vars.
    R2_ACCOUNT_ID: str = ""
    R2_ACCESS_KEY_ID: str = ""
    R2_SECRET_ACCESS_KEY: str = ""
    R2_BUCKET_NAME: str = ""
    R2_ENDPOINT: str = ""  # e.g. https://<account_id>.r2.cloudflarestorage.com
    R2_PRESIGNED_UPLOAD_EXPIRY: int = 86400  # seconds — 24 hours, generous enough for a very large recording even on a slow/interrupted connection. Well within S3-compatible presigned URLs' own protocol maximum (7 days for SigV4).
    R2_PRESIGNED_DOWNLOAD_EXPIRY: int = 3600  # seconds

    # How long a signed READ url for a Supabase-hosted file stays valid.
    # Generated fresh every time someone loads /s/{share_id} (never
    # cached/stored), so this only needs to comfortably cover one
    # viewing session -- not the share link's overall lifetime, since
    # revisiting the link generates a brand new signed URL each time.
    SUPABASE_PRESIGNED_DOWNLOAD_EXPIRY: int = 3600  # seconds

    # Optional org-wide policy: if set, every NEW share link automatically
    # gets this expiration applied at creation time, regardless of
    # storage destination -- a corporate retention/compliance default,
    # not just a per-share opt-in. A client can still request a SHORTER
    # expiration (e.g. "expires in 1 hour" for a especially sensitive
    # share); it can never request longer than this or "never expires"
    # once an admin has set it. Leave unset for no forced default.
    DEFAULT_SHARE_EXPIRY_DAYS: int = 0  # 0 = no forced default

    # Secret used to sign short-lived download tokens for
    # password-protected shares (see app/services/share_security.py) --
    # lets someone who already entered the password download the file
    # without re-entering it, without needing session/cookie
    # infrastructure. Auto-generates a random one per process if left
    # unset, which is fine for a single-instance deployment but means
    # tokens won't validate across a restart or multiple instances --
    # set this explicitly in production for exactly that reason.
    SHARE_TOKEN_SECRET: str = ""

    @property
    def max_file_size_bytes(self):
        """None means no cap is enforced (the MAX_FILE_SIZE_MB=0 default).
        This cap, when set, is enforced for BOTH upload paths (the direct
        /api/upload endpoint and R2 presigned uploads), but the two
        differ in an important way: R2 uploads go directly from the
        browser to R2 storage, never touching this server's memory --
        the file's actual size is essentially irrelevant to this
        backend's own resource usage regardless of any cap. /api/upload
        does NOT have that property: it receives the full file over HTTP
        and holds it in server memory before forwarding it to Supabase
        Storage (whose Python client only accepts raw bytes, not a
        stream -- there is no way to avoid this from application code
        without switching storage clients). With no cap at all, a very
        large upload through /api/upload specifically will use server
        memory proportional to its size -- for very large recordings
        (many hundreds of MB+), prefer the R2 destination regardless of
        what this setting is, since it doesn't have that constraint.
        Separately: whatever host this runs on may impose its OWN
        request body size limit ahead of this application entirely
        (a reverse proxy or platform-level cap) -- that is outside
        anything this setting can control, and R2 sidesteps it too,
        since the large bytes never hit this server's own HTTP endpoint.
        Set MAX_FILE_SIZE_MB to a positive number to re-enable a cap,
        e.g. if this backend runs on a memory-constrained host and you
        want /api/upload specifically protected against extreme sizes."""
        if self.MAX_FILE_SIZE_MB <= 0:
            return None
        return self.MAX_FILE_SIZE_MB * 1024 * 1024

    @property
    def effective_public_base_url(self) -> str:
        """
        The base URL used to build share links (see
        app/services/sharing.py). Render automatically injects
        RENDER_EXTERNAL_URL with the service's real https://*.onrender.com
        address -- if PUBLIC_BASE_URL was left at its localhost default
        (i.e. nobody explicitly set it), we prefer Render's own URL. That
        means a fresh Render deploy produces working share links
        immediately, with no "deploy once to learn the URL, then set an
        env var and redeploy" round trip. Setting PUBLIC_BASE_URL
        explicitly (e.g. to a custom domain) always takes precedence.
        """
        render_url = os.environ.get("RENDER_EXTERNAL_URL")
        if render_url and self.PUBLIC_BASE_URL == _DEFAULT_PUBLIC_BASE_URL:
            return render_url.rstrip("/")
        return self.PUBLIC_BASE_URL.rstrip("/")

    @property
    def cors_origins(self) -> List[str]:
        origins: List[str] = []
        if self.ALLOWED_EXTENSION_ORIGINS:
            origins.extend([o.strip() for o in self.ALLOWED_EXTENSION_ORIGINS.split(",") if o.strip()])
        if self.EXTRA_CORS_ORIGINS:
            origins.extend([o.strip() for o in self.EXTRA_CORS_ORIGINS.split(",") if o.strip()])
        return origins

    @property
    def supabase_configured(self) -> bool:
        return bool(self.SUPABASE_URL and self.SUPABASE_SERVICE_ROLE_KEY)

    @property
    def r2_configured(self) -> bool:
        return bool(
            self.R2_ACCOUNT_ID
            and self.R2_ACCESS_KEY_ID
            and self.R2_SECRET_ACCESS_KEY
            and self.R2_BUCKET_NAME
        )

    @property
    def r2_endpoint(self) -> str:
        return self.R2_ENDPOINT or f"https://{self.R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

    @property
    def effective_share_token_secret(self) -> str:
        global _generated_token_secret
        if self.SHARE_TOKEN_SECRET:
            return self.SHARE_TOKEN_SECRET
        if _generated_token_secret is None:
            _generated_token_secret = secrets.token_urlsafe(32)
        return _generated_token_secret


_generated_token_secret: str | None = None


@lru_cache
def get_settings() -> "Settings":
    return Settings()
