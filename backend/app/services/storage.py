"""
app/services/storage.py
Thin wrapper around the Supabase Python client for uploading capture
files to Supabase Storage and writing/reading their metadata row in
Postgres. This is the ONLY module that touches the service-role key.
"""
from __future__ import annotations

import mimetypes
from datetime import datetime, timezone
from typing import Optional

from supabase import Client, create_client

from app.config import get_settings

settings = get_settings()

_client: Optional[Client] = None


def get_supabase_client() -> Client:
    global _client
    if _client is None:
        if not settings.supabase_configured:
            raise RuntimeError(
                "Supabase is not configured. Set SUPABASE_URL and "
                "SUPABASE_SERVICE_ROLE_KEY in your .env file."
            )
        _client = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)
    return _client


def build_storage_path(share_id: str, filename: str, now: Optional[datetime] = None) -> str:
    now = now or datetime.now(timezone.utc)
    ext = ""
    if "." in filename:
        ext = filename.rsplit(".", 1)[-1].lower()
    elif "/" in filename:  # nothing usable — fall back below
        pass
    if not ext:
        ext = "bin"
    return f"captures/{now.year:04d}/{now.month:02d}/{share_id}.{ext}"


def upload_file_bytes(storage_path: str, data: bytes, mime_type: str) -> str:
    """Uploads bytes to the configured bucket and returns a signed read
    URL (not the bucket's public URL -- see generate_supabase_signed_read_url's
    docstring for why that assumption was a real bug)."""
    client = get_supabase_client()
    bucket = client.storage.from_(settings.SUPABASE_BUCKET)
    content_type = mime_type or mimetypes.guess_type(storage_path)[0] or "application/octet-stream"
    bucket.upload(
        storage_path,
        data,
        {"content-type": content_type, "upsert": "false"},
    )
    return generate_supabase_signed_read_url(storage_path)


def generate_supabase_signed_read_url(storage_path: str, expires_in: Optional[int] = None) -> str:
    """A signed, time-limited READ url for a Supabase Storage object --
    used instead of get_public_url() everywhere a file actually needs to
    be servable. get_public_url() only produces a URL that WORKS if the
    bucket itself is configured as public; a great many Supabase
    projects use private buckets by default (often the safer, and
    sometimes the only option depending on how the project was set up),
    in which case a "public" URL 404s or 400s for every viewer even
    though the upload itself succeeded -- this was a real, likely cause
    of "the link doesn't work" reports. A signed URL works regardless of
    the bucket's public/private setting, generated fresh (never
    cached/stored) each time a share page is actually viewed."""
    client = get_supabase_client()
    bucket = client.storage.from_(settings.SUPABASE_BUCKET)
    result = bucket.create_signed_url(storage_path, expires_in or settings.SUPABASE_PRESIGNED_DOWNLOAD_EXPIRY)
    return result["signedURL"]


def create_signed_upload(storage_path: str) -> dict:
    """Generates a Supabase Storage signed upload URL + token, scoped to
    this one object path. This is what makes an "unlimited size" upload
    genuinely possible for the Supabase destination: the browser PUTs the
    file directly to this URL, and this backend's own HTTP handlers never
    see the file bytes at all -- no double network hop (browser -> this
    server -> Supabase), no holding the whole file in this server's
    memory, and no exposure to whatever request-size limit a reverse
    proxy in front of this server might otherwise impose. The privileged
    service-role key is used here, server-side, only to GENERATE this
    scoped, single-object, time-limited credential -- it is never sent to
    or usable by the browser. See app/routes/upload.py's
    /api/upload/signed-url and /api/upload/complete for the full flow."""
    client = get_supabase_client()
    bucket = client.storage.from_(settings.SUPABASE_BUCKET)
    return bucket.create_signed_upload_url(storage_path)


def get_uploaded_object_size(storage_path: str) -> Optional[int]:
    """Verifies an object actually exists at storage_path (i.e. the
    direct browser-to-Supabase upload genuinely completed) and returns
    its real, server-recorded size -- mirrors R2's head_object-based
    verification (app/services/r2_storage.py) rather than trusting a
    client-reported size for a file this backend never directly
    received. Returns None if the object isn't found."""
    client = get_supabase_client()
    bucket = client.storage.from_(settings.SUPABASE_BUCKET)
    if "/" in storage_path:
        folder, filename = storage_path.rsplit("/", 1)
    else:
        folder, filename = "", storage_path
    entries = bucket.list(folder)
    for entry in entries:
        if entry.get("name") == filename:
            metadata = entry.get("metadata") or {}
            size = metadata.get("size")
            return int(size) if size is not None else None
    return None


def insert_capture_row(record: dict) -> dict:
    client = get_supabase_client()
    result = client.table("captures").insert(record).execute()
    return result.data[0]


def get_capture_row(share_id: str) -> Optional[dict]:
    client = get_supabase_client()
    result = client.table("captures").select("*").eq("share_id", share_id).limit(1).execute()
    return result.data[0] if result.data else None


def update_capture_row(share_id: str, patch: dict) -> Optional[dict]:
    client = get_supabase_client()
    result = client.table("captures").update(patch).eq("share_id", share_id).execute()
    return result.data[0] if result.data else None


def list_capture_rows(client_id: Optional[str] = None, limit: int = 50, offset: int = 0) -> list[dict]:
    client = get_supabase_client()
    query = client.table("captures").select("*").order("created_at", desc=True).range(offset, offset + limit - 1)
    if client_id:
        query = query.eq("client_id", client_id)
    result = query.execute()
    return result.data or []


def delete_capture_row(share_id: str) -> Optional[dict]:
    """Deletes the DB row and, for Supabase-backed captures, the underlying
    file. R2-backed rows (storage_provider == "r2") only have their DB row
    removed here — callers deleting an R2 capture are expected to also call
    r2_storage.delete_object() themselves, since that's a different set of
    credentials/client entirely and doesn't belong in this module."""
    client = get_supabase_client()
    row = get_capture_row(share_id)
    if not row:
        return None
    if row.get("storage_provider", "supabase") == "supabase":
        client.storage.from_(settings.SUPABASE_BUCKET).remove([row["storage_path"]])
    client.table("captures").delete().eq("share_id", share_id).execute()
    return row
