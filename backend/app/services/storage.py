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
    """Uploads bytes to the configured bucket and returns the public URL."""
    client = get_supabase_client()
    bucket = client.storage.from_(settings.SUPABASE_BUCKET)
    content_type = mime_type or mimetypes.guess_type(storage_path)[0] or "application/octet-stream"
    bucket.upload(
        storage_path,
        data,
        {"content-type": content_type, "upsert": "false"},
    )
    return bucket.get_public_url(storage_path)


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
