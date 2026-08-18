"""
app/routes/upload.py
POST /api/upload — accepts a capture file + metadata, validates it,
uploads it to Supabase Storage, and records its metadata in Postgres.

Security notes:
- MIME type and extension are both validated against an allow-list.
- File size is enforced against MAX_FILE_SIZE_MB (413 on overflow).
- Share IDs are generated with secrets.token_urlsafe — unpredictable.
- The Supabase service-role key never leaves this process.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.config import get_settings
from app.models.capture import UploadResponse
from app.services.sharing import build_share_url, generate_share_id
from app.services.storage import build_storage_path, insert_capture_row, upload_file_bytes

router = APIRouter()
settings = get_settings()

ALLOWED_MIME_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "video/webm",
    "video/mp4",
}

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "webm", "mp4"}


def _base_mime_type(content_type: str) -> str:
    """Strips codec parameters for validation purposes only.

    MediaRecorder reports (and the extension stores/sends) the *full*
    Content-Type it actually recorded with, e.g.
    "video/webm;codecs=vp9,opus" -- that's correct, useful metadata, and
    exactly what gets set as the stored object's real Content-Type. But
    it means a naive `mime_type in ALLOWED_MIME_TYPES` exact-match check
    rejects every real recording, since MediaRecorder never reports a
    bare "video/webm" with no codec info. Screenshots never hit this
    because "image/png" never carries codec parameters. Validate against
    the base type; keep the original full string everywhere else
    (storage upload, DB row, presigned URL signing).
    """
    return content_type.split(";")[0].strip().lower()


def _validate_filename(filename: str) -> str:
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename.")
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file extension: .{ext}")
    return ext


@router.post("/api/upload", response_model=UploadResponse)
async def upload_capture(
    file: UploadFile = File(...),
    type: str = Form(...),
    name: str = Form(...),
    mime_type: str = Form(...),
):
    if type not in ("screenshot", "recording"):
        raise HTTPException(status_code=400, detail="type must be 'screenshot' or 'recording'.")

    if _base_mime_type(mime_type) not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported MIME type: {mime_type}")

    _validate_filename(name)

    data = await file.read()
    size_bytes = len(data)

    if size_bytes == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    if size_bytes > settings.max_file_size_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds the {settings.MAX_FILE_SIZE_MB}MB upload limit.",
        )

    if not settings.supabase_configured:
        raise HTTPException(
            status_code=503,
            detail="Cloud sharing is not configured on this server yet. "
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the backend .env file.",
        )

    share_id = generate_share_id()
    now = datetime.now(timezone.utc)
    storage_path = build_storage_path(share_id, name, now)

    try:
        file_url = upload_file_bytes(storage_path, data, mime_type)
        row = insert_capture_row(
            {
                "share_id": share_id,
                "type": type,
                "original_filename": name,
                "storage_path": storage_path,
                "mime_type": mime_type,
                "size_bytes": size_bytes,
                "duration_seconds": 0,
                "created_at": now.isoformat(),
                "expires_at": None,
            }
        )
    except Exception as exc:  # noqa: BLE001 — surfaced as a clean 502 to the client
        raise HTTPException(status_code=502, detail=f"Upload to storage failed: {exc}") from exc

    return UploadResponse(
        success=True,
        id=row["share_id"],
        share_url=build_share_url(share_id),
        file_url=file_url,
    )
