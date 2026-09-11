"""
app/routes/share.py
- GET  /api/share/{share_id}          -> JSON metadata (used by the extension)
- POST /api/share/{share_id}/password -> set/change/remove password protection
- DELETE /api/share/{share_id}        -> delete a share (row + underlying file)
- GET  /s/{share_id}                  -> human-facing HTML viewer (any browser)
- POST /s/{share_id}                  -> password-form submission for a protected share
- GET  /s/{share_id}/download         -> counted download redirect

Storage-provider-aware: a capture's `storage_provider` column (see
app/services/r2_storage.py / app/routes/media.py) decides whether the
actual file bytes are resolved via a Supabase public URL or a short-lived
R2 presigned GET URL. This is intentionally the ONE place both flows
converge on a public-facing viewer, rather than R2 getting its own
parallel /share/<token> route — see app/routes/media.py's module
docstring for why.

Password protection is deliberately stateless (no session/cookie system
exists anywhere else in this backend): GET /s/{id} on a protected share
renders a password form; POST /s/{id} with the right password renders
the content directly in that same response. The page's own Download
link embeds a short-lived signed token (app/services/share_security.py)
so clicking Download right after unlocking the page doesn't ask for the
password again, without needing session state.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app.config import get_settings
from app.models.capture import SetSharePasswordRequest, ShareInfoResponse
from app.services import r2_storage, share_security
from app.services.storage import (
    delete_capture_row,
    generate_supabase_signed_read_url,
    get_capture_row,
    update_capture_row,
)

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
    # A signed URL, not get_public_url() -- works whether the bucket is
    # public or private (a great many Supabase projects use private
    # buckets), and generated fresh every time this function runs rather
    # than cached, so its expiry only needs to cover one viewing session.
    # See app/services/storage.py's generate_supabase_signed_read_url for
    # the full reasoning -- this was a real, likely cause of "the upload
    # succeeds but the link doesn't actually work."
    return generate_supabase_signed_read_url(row["storage_path"])


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


def _render_password_form(request: Request, share_id: str, error: str | None = None) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "share.html",
        {"password_required": True, "share_id": share_id, "password_error": error},
        status_code=401,
    )


def _render_capture(request: Request, row: dict, share_id: str, download_token: str | None = None) -> HTMLResponse:
    download_url = f"/s/{share_id}/download"
    if download_token:
        download_url += f"?t={download_token}"
    capture_view = {
        "type": row["type"],
        "original_filename": row["original_filename"],
        "file_url": _resolve_file_url(row),
        "download_url": download_url,
        "created_at_display": str(row["created_at"])[:16].replace("T", " "),
        "size_display": _format_bytes(row["size_bytes"]),
        "duration_display": _format_duration(row.get("duration_seconds") or 0),
    }
    return templates.TemplateResponse(request, "share.html", {"capture": capture_view})


@router.get("/api/share/{share_id}", response_model=ShareInfoResponse)
def get_share_info(share_id: str, password: str | None = None):
    _require_supabase()
    row = get_capture_row(share_id)
    if not row:
        raise HTTPException(status_code=404, detail="This share link was not found or has been deleted.")

    unavailable = _availability_error(row)
    if unavailable:
        raise HTTPException(status_code=410, detail=unavailable[1])

    if row.get("password_hash"):
        if not password or not share_security.verify_password(password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="This share is password-protected. Supply the correct password.")

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


@router.post("/api/share/{share_id}/password")
def set_share_password(share_id: str, payload: SetSharePasswordRequest):
    _require_supabase()
    row = get_capture_row(share_id)
    if not row:
        raise HTTPException(status_code=404, detail="This share link was not found.")

    if payload.password:
        update_capture_row(share_id, {"password_hash": share_security.hash_password(payload.password)})
        return {"success": True, "password_protected": True}

    update_capture_row(share_id, {"password_hash": None})
    return {"success": True, "password_protected": False}


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

    if row.get("password_hash"):
        return _render_password_form(request, share_id)

    update_capture_row(share_id, {"view_count": (row.get("view_count") or 0) + 1})
    return _render_capture(request, row, share_id)


@router.post("/s/{share_id}", response_class=HTMLResponse)
def share_viewer_unlock(request: Request, share_id: str, password: str = Form(...)):
    _require_supabase()
    row = get_capture_row(share_id)
    if not row:
        return _render_error(
            request, "Link not found", "This share link doesn't exist or has been deleted.", status_code=404
        )

    unavailable = _availability_error(row)
    if unavailable:
        return _render_error(request, *unavailable)

    if row.get("password_hash") and not share_security.verify_password(password, row["password_hash"]):
        return _render_password_form(request, share_id, error="Incorrect password — try again.")

    update_capture_row(share_id, {"view_count": (row.get("view_count") or 0) + 1})
    token = share_security.generate_download_token(share_id, settings.effective_share_token_secret)
    return _render_capture(request, row, share_id, download_token=token)


@router.get("/s/{share_id}/download")
def share_download(request: Request, share_id: str, t: str | None = None):
    _require_supabase()
    row = get_capture_row(share_id)
    if not row:
        return _render_error(request, "Link not found", "This share link doesn't exist or has been deleted.", 404)

    unavailable = _availability_error(row)
    if unavailable:
        return _render_error(request, *unavailable)

    if row.get("password_hash"):
        valid_token = t and share_security.verify_download_token(share_id, t, settings.effective_share_token_secret)
        if not valid_token:
            return _render_error(
                request,
                "Password required",
                "This download link needs the share's password. Open the share page and enter it there first.",
                status_code=401,
            )

    update_capture_row(share_id, {"download_count": (row.get("download_count") or 0) + 1})
    return RedirectResponse(url=_resolve_file_url(row))
