"""
app/services/r2_storage.py
Cloudflare R2 storage service (S3-compatible via boto3). Owns everything
that touches R2 credentials -- presigned URL generation, object key
naming, existence checks, deletion, and upload validation. Nothing here
is imported by the extension; only app/routes/media.py calls into it.

R2 is treated as a *second, independent* storage backend alongside the
existing Supabase-backed "backend" destination and Google Drive -- see
app/services/storage.py (Supabase) and extension/shared/drive.js. All
three share the same conceptual shape (upload bytes, get a link back)
but each destination's actual mechanics stay isolated in its own module,
which is what keeps app/routes/media.py (and extension/shared/share.js on
the client) simple dispatchers instead of a tangle of branching logic.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Optional

import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import ClientError

from app.config import get_settings

settings = get_settings()

_client = None

# Deliberately narrow allow-lists -- same spirit as app/routes/upload.py's
# ALLOWED_MIME_TYPES: only what SatyLens itself actually produces.
ALLOWED_CONTENT_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "video/webm": "webm",
    "video/mp4": "mp4",
}

_SAFE_MEDIA_TYPES = {"screenshot", "recording", "collage"}


def _base_content_type(content_type: str) -> str:
    """Strips codec parameters for validation/extension-lookup purposes
    only -- see the matching helper + comment in app/routes/upload.py for
    why MediaRecorder-produced content types (e.g.
    "video/webm;codecs=vp9,opus") need this. The full original string is
    still what gets signed into the presigned PUT URL and stored as the
    object's real Content-Type -- only these two lookups need the bare
    type."""
    return content_type.split(";")[0].strip().lower()


class R2ValidationError(ValueError):
    """Raised for any client-supplied value that fails validation --
    callers should turn this into an HTTP 400, not a 500."""


def get_r2_client():
    global _client
    if _client is None:
        if not settings.r2_configured:
            raise RuntimeError(
                "Cloudflare R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, "
                "R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME in your .env file."
            )
        _client = boto3.client(
            "s3",
            endpoint_url=settings.r2_endpoint,
            aws_access_key_id=settings.R2_ACCESS_KEY_ID,
            aws_secret_access_key=settings.R2_SECRET_ACCESS_KEY,
            config=BotoConfig(signature_version="s3v4", region_name="auto"),
        )
    return _client


def validate_upload_request(media_type: str, content_type: str, file_size: int) -> str:
    """Returns the file extension to use, or raises R2ValidationError."""
    if media_type not in _SAFE_MEDIA_TYPES:
        raise R2ValidationError(f"Unsupported media_type: {media_type}")
    base_type = _base_content_type(content_type)
    if base_type not in ALLOWED_CONTENT_TYPES:
        raise R2ValidationError(f"Unsupported content type: {content_type}")
    if file_size <= 0:
        raise R2ValidationError("file_size must be greater than zero.")
    if file_size > settings.max_file_size_bytes:
        raise R2ValidationError(
            f"File exceeds the {settings.MAX_FILE_SIZE_MB}MB upload limit."
        )
    return ALLOWED_CONTENT_TYPES[base_type]


def build_object_key(media_type: str, client_id: str, extension: str, now: Optional[datetime] = None) -> str:
    """
    screenshots/{client_id}/{yyyy}/{mm}/{uuid}.png
    Never derived from the client-supplied filename -- that's what keeps
    this immune to path traversal (`../../etc/passwd`) and key collisions.
    """
    now = now or datetime.now(timezone.utc)
    folder = {"screenshot": "screenshots", "recording": "recordings", "collage": "collages"}[media_type]
    safe_client_id = re.sub(r"[^a-zA-Z0-9_-]", "", client_id)[:64] or "anonymous"
    object_id = str(uuid.uuid4())
    return f"{folder}/{safe_client_id}/{now.year:04d}/{now.month:02d}/{object_id}.{extension}"


def generate_presigned_put_url(object_key: str, content_type: str) -> str:
    client = get_r2_client()
    return client.generate_presigned_url(
        "put_object",
        Params={"Bucket": settings.R2_BUCKET_NAME, "Key": object_key, "ContentType": content_type},
        ExpiresIn=settings.R2_PRESIGNED_UPLOAD_EXPIRY,
    )


def generate_presigned_get_url(object_key: str, expires_in: Optional[int] = None) -> str:
    client = get_r2_client()
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.R2_BUCKET_NAME, "Key": object_key},
        ExpiresIn=expires_in or settings.R2_PRESIGNED_DOWNLOAD_EXPIRY,
    )


def object_exists(object_key: str) -> tuple[bool, int]:
    """Returns (exists, size_bytes). Used by /api/media/complete so we
    never mark an upload 'complete' on the client's word alone."""
    client = get_r2_client()
    try:
        head = client.head_object(Bucket=settings.R2_BUCKET_NAME, Key=object_key)
        return True, head.get("ContentLength", 0)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("404", "NoSuchKey", "NotFound"):
            return False, 0
        raise


def delete_object(object_key: str) -> None:
    client = get_r2_client()
    client.delete_object(Bucket=settings.R2_BUCKET_NAME, Key=object_key)
