"""
app/config.py
Centralized settings loaded from environment variables (.env in dev).
Never hardcode secrets here -- everything sensitive comes from the
environment so it can be injected safely by the deployment platform
(Render, Railway, etc.) without touching source control.
"""
import os
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
    MAX_FILE_SIZE_MB: int = 100

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
    R2_PRESIGNED_UPLOAD_EXPIRY: int = 900  # seconds
    R2_PRESIGNED_DOWNLOAD_EXPIRY: int = 3600  # seconds

    @property
    def max_file_size_bytes(self) -> int:
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


@lru_cache
def get_settings() -> "Settings":
    return Settings()
