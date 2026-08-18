"""
app/routes/media.py
R2 direct-upload flow + link management, built on the same `captures`
table as the existing Supabase-backend and (conceptually) Google Drive
destinations -- see app/models/media.py for why a parallel schema wasn't
introduced. The public share/viewer route is intentionally NOT duplicated
here: R2-backed captures are viewed through the existing GET /s/{share_id}
(app/routes/share.py), which was made storage-provider-aware rather than
adding a second, near-identical /share/<token> route.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query

from app.config import get_settings
from app.models.media import (
    CompleteUploadRequest,
    CompleteUploadResponse,
    ExpireRequest,
    MediaDetailResponse,
    MediaHistoryItem,
    UploadUrlRequest,
    UploadUrlResponse,
)
from app.services import r2_storage
from app.services.sharing import build_share_url, generate_share_id
from app.services.storage import (
    delete_capture_row,
    get_capture_row,
    insert_capture_row,
    list_capture_rows,
    update_capture_row,
)

router = APIRouter()
settings = get_settings()


def _require_supabase() -> None:
    if not settings.supabase_configured:
        raise HTTPException(
            status_code=503,
            detail="Metadata storage is not configured on this server yet. "
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the backend .env file.",
        )


def _require_r2() -> None:
    if not settings.r2_configured:
        raise HTTPException(
            status_code=503,
            detail="Cloudflare R2 is not configured on this server yet. "
            "Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and "
            "R2_BUCKET_NAME in the backend .env file. See R2_SETUP.md.",
        )


def _row_to_history_item(row: dict) -> MediaHistoryItem:
    return MediaHistoryItem(
        id=row["share_id"],
        media_type=row["type"],
        file_name=row["original_filename"],
        size_bytes=row["size_bytes"],
        created_at=row["created_at"],
        expires_at=row.get("expires_at"),
        revoked=bool(row.get("revoked", False)),
        view_count=row.get("view_count", 0) or 0,
        download_count=row.get("download_count", 0) or 0,
        share_url=build_share_url(row["share_id"]),
    )


@router.post("/api/media/upload-url", response_model=UploadUrlResponse)
async def create_upload_url(payload: UploadUrlRequest):
    _require_supabase()
    _require_r2()

    try:
        extension = r2_storage.validate_upload_request(
            payload.media_type, payload.content_type, payload.file_size
        )
    except r2_storage.R2ValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    upload_id = generate_share_id()
    object_key = r2_storage.build_object_key(payload.media_type, payload.client_id or "anonymous", extension)

    try:
        upload_url = r2_storage.generate_presigned_put_url(object_key, payload.content_type)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Could not create an R2 upload URL: {exc}") from exc

    now = datetime.now(timezone.utc)
    insert_capture_row(
        {
            "share_id": upload_id,
            "type": payload.media_type,
            "original_filename": payload.file_name,
            "storage_path": object_key,
            "mime_type": payload.content_type,
            "size_bytes": payload.file_size,  # client-claimed; verified for real in /complete
            "duration_seconds": 0,
            "created_at": now.isoformat(),
            "expires_at": None,
            "storage_provider": "r2",
            "status": "pending",
            "client_id": payload.client_id,
        }
    )

    return UploadUrlResponse(
        success=True,
        upload_url=upload_url,
        object_key=object_key,
        upload_id=upload_id,
        expires_in=settings.R2_PRESIGNED_UPLOAD_EXPIRY,
    )


@router.post("/api/media/complete", response_model=CompleteUploadResponse)
async def complete_upload(payload: CompleteUploadRequest):
    _require_supabase()
    _require_r2()

    row = get_capture_row(payload.upload_id)
    if not row:
        raise HTTPException(status_code=404, detail="Unknown upload_id — call /api/media/upload-url first.")
    if row["storage_path"] != payload.object_key:
        raise HTTPException(status_code=400, detail="object_key does not match this upload session.")

    # Never trust the client's word that the upload succeeded — check R2
    # directly and use R2's own reported size, not whatever the client sent.
    exists, actual_size = r2_storage.object_exists(payload.object_key)
    if not exists:
        raise HTTPException(
            status_code=400,
            detail="The file was not found in R2 yet. Make sure the PUT upload finished, then retry.",
        )

    update_capture_row(payload.upload_id, {"status": "complete", "size_bytes": actual_size})
    return CompleteUploadResponse(
        success=True, id=payload.upload_id, share_url=build_share_url(payload.upload_id)
    )


@router.get("/api/media/history", response_model=list[MediaHistoryItem])
async def media_history(
    client_id: str = Query(..., min_length=8, max_length=128),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    _require_supabase()
    rows = list_capture_rows(client_id=client_id, limit=limit, offset=offset)
    return [_row_to_history_item(r) for r in rows if r.get("status", "complete") == "complete"]


@router.get("/api/media/{share_id}", response_model=MediaDetailResponse)
async def media_detail(share_id: str):
    _require_supabase()
    row = get_capture_row(share_id)
    if not row:
        raise HTTPException(status_code=404, detail="No media found for this id.")
    item = _row_to_history_item(row)
    return MediaDetailResponse(
        **item.model_dump(),
        content_type=row["mime_type"],
        storage_provider=row.get("storage_provider", "supabase"),
    )


@router.post("/api/media/{share_id}/revoke")
async def revoke_media(share_id: str):
    _require_supabase()
    row = get_capture_row(share_id)
    if not row:
        raise HTTPException(status_code=404, detail="No media found for this id.")
    update_capture_row(share_id, {"revoked": True})
    return {"success": True, "revoked": share_id}


@router.post("/api/media/{share_id}/expire")
async def set_media_expiration(share_id: str, payload: ExpireRequest):
    _require_supabase()
    row = get_capture_row(share_id)
    if not row:
        raise HTTPException(status_code=404, detail="No media found for this id.")
    expires_at = None
    if payload.hours is not None:
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=payload.hours)).isoformat()
    update_capture_row(share_id, {"expires_at": expires_at})
    return {"success": True, "expires_at": expires_at}


@router.post("/api/media/{share_id}/delete")
async def delete_media(share_id: str):
    _require_supabase()
    row = get_capture_row(share_id)
    if not row:
        raise HTTPException(status_code=404, detail="No media found for this id.")

    if row.get("storage_provider") == "r2":
        _require_r2()
        try:
            r2_storage.delete_object(row["storage_path"])
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"Could not delete the R2 object: {exc}") from exc

    delete_capture_row(share_id)
    return {"success": True, "deleted": share_id}
