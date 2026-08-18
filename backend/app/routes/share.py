"""
app/routes/share.py
- GET  /api/share/{share_id}          -> JSON metadata (used by the extension)
- DELETE /api/share/{share_id}        -> delete a share (row + underlying file)
- GET  /s/{share_id}                  -> human-facing HTML viewer (any browser)
- GET  /s/{share_id}/download         -> counted download redirect

Storage-provider-aware: a capture's `storage_provider` column (see
app/services/r2_storage.py / app/routes/media.py) decides whether the
actual file bytes are resolved via a Supabase public URL or a short-lived
R2 presigned GET URL. This is intentionally the ONE place both flows
converge on a public-facing viewer, rather than R2 getting its own
parallel /share/<token> route — see app/routes/media.py's module
docstring for why.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app.config import get_settings
from app.models.capture import ShareInfoResponse
from app.services import r2_storage
from app.services.storage import get_capture_row, get_supabase_client, update_capture_row, delete_capture_row

router = APIRouter()
settings = get_settings()

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


def _require_supabase() -> None:
    if not settings.supabase_configured:
        raise HTTPException(
            status_code=503,
            detail="Cloud sharing is not configured on this server yet. "
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the backend .env file.",
        )


def _resolve_file_url(row: dict) -> str:
    provider = row.get("storage_provider", "supabase")
    if provider == "r2":
        return r2_storage.generate_presigned_get_url(row["storage_path"])
    client = get_supabase_client()
    return client.storage.from_(settings.SUPABASE_BUCKET).get_public_url(row["storage_path"])


def _availability_error(row: dict) -> tuple[str, str] | None:
    """Returns (title, message) if this share should NOT be servable right
    now, else None. Covers: still uploading, revoked, expired."""
    if row.get("status", "complete") == "pending":
        return ("Upload still in progress", "This share link isn't ready yet — try again in a moment.")
    if row.get("revoked"):
        return ("This link has been revoked", "The person who shared this removed access to it.")
    expires_at = row.get("expires_at")
    if expires_at:
        expires_dt = expires_at if isinstance(expires_at, datetime) else datetime.fromisoformat(str(expires_at))
        if expires_dt.tzinfo is None:
            expires_dt = expires_dt.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) > expires_dt:
            return ("This link has expired", "Ask the sender for a new share link.")
    return None


def _format_bytes(n: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    size = float(n)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


def _format_duration(seconds: float) -> str:
    if not seconds:
        return ""
    total = int(seconds)
    m, s = divmod(total, 60)
    return f"{m}:{s:02d}"


def _render_error(request: Request, title: str, message: str, status_code: int = 410) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "share.html",
        {"error": True, "error_title": title, "error_message": message},
        status_code=status_code,
    )


@router.get("/api/share/{share_id}", response_model=ShareInfoResponse)
def get_share_info(share_id: str):
    _require_supabase()
    row = get_capture_row(share_id)
    if not row:
        raise HTTPException(status_code=404, detail="This share link was not found or has been deleted.")

    unavailable = _availability_error(row)
    if unavailable:
        raise HTTPException(status_code=410, detail=unavailable[1])

    return ShareInfoResponse(
        id=row["share_id"],
        type=row["type"],
        original_filename=row["original_filename"],
        mime_type=row["mime_type"],
        size_bytes=row["size_bytes"],
        duration_seconds=row.get("duration_seconds") or 0,
        created_at=row["created_at"],
        file_url=_resolve_file_url(row),
    )


@router.delete("/api/share/{share_id}")
def delete_share(share_id: str):
    _require_supabase()
    row = get_capture_row(share_id)
    if not row:
        raise HTTPException(status_code=404, detail="This share link was not found.")
    if row.get("storage_provider") == "r2":
        try:
            r2_storage.delete_object(row["storage_path"])
        except Exception:  # noqa: BLE001 — DB row removal still proceeds below
            pass
    delete_capture_row(share_id)
    return {"success": True, "deleted": share_id}


@router.get("/s/{share_id}", response_class=HTMLResponse)
def share_viewer(request: Request, share_id: str):
    _require_supabase()
    row = get_capture_row(share_id)
    if not row:
        return _render_error(
            request, "Link not found", "This share link doesn't exist or has been deleted.", status_code=404
        )

    unavailable = _availability_error(row)
    if unavailable:
        return _render_error(request, *unavailable)

    update_capture_row(share_id, {"view_count": (row.get("view_count") or 0) + 1})

    capture_view = {
        "type": row["type"],
        "original_filename": row["original_filename"],
        "file_url": _resolve_file_url(row),
        "download_url": f"/s/{share_id}/download",
        "created_at_display": str(row["created_at"])[:16].replace("T", " "),
        "size_display": _format_bytes(row["size_bytes"]),
        "duration_display": _format_duration(row.get("duration_seconds") or 0),
    }
    return templates.TemplateResponse(request, "share.html", {"capture": capture_view})


@router.get("/s/{share_id}/download")
def share_download(request: Request, share_id: str):
    _require_supabase()
    row = get_capture_row(share_id)
    if not row:
        return _render_error(request, "Link not found", "This share link doesn't exist or has been deleted.", 404)

    unavailable = _availability_error(row)
    if unavailable:
        return _render_error(request, *unavailable)

    update_capture_row(share_id, {"download_count": (row.get("download_count") or 0) + 1})
    return RedirectResponse(url=_resolve_file_url(row))
