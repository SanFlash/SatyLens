"""
app/routes/upload.py

POST /api/upload/signed-url + POST /api/upload/complete — the primary
upload flow as of this file's current version. The extension itself
uses this pair now: the browser gets a short-lived, single-object
signed upload URL from this backend, PUTs the file directly to Supabase
Storage (this backend's own HTTP handlers never see the file bytes),
then confirms completion so the backend can verify the object actually
landed and read its real size before marking the row complete. This
mirrors the Cloudflare R2 destination's existing architecture (see
app/routes/media.py) and has no meaningful size ceiling of its own.

POST /api/upload — the ORIGINAL upload endpoint, which accepts the full
file body directly and buffers it in this server's memory before
forwarding it to Supabase Storage. Kept for backward compatibility (a
cached/un-updated extension build, or any other integration that might
still call it) but no longer used by the extension itself, and not
recommended for large files: it makes two network hops (browser to this
backend, then this backend to Supabase Storage) instead of one, and
that memory-buffering step is a real bottleneck this specific endpoint
can't avoid (Supabase's storage client only accepts raw bytes, not a
stream) -- which is exactly why the signed-upload flow above exists.

Security notes (apply to both flows):
- MIME type and extension are both validated against an allow-list.
- File size is enforced against MAX_FILE_SIZE_MB when set (413 on
  overflow) for the legacy /api/upload endpoint; the signed-upload flow
  has no size check of its own to enforce, since this backend never
  receives the bytes to measure in the first place.
- Share IDs are generated with secrets.token_urlsafe — unpredictable.
- The Supabase service-role key never leaves this process; the signed
  upload URL handed to the browser is a scoped, single-object,
  time-limited credential generated using that key server-side, not the
  key itself.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.config import get_settings
from app.models.capture import CompleteSignedUploadRequest, SignedUploadUrlRequest, SignedUploadUrlResponse, UploadResponse
from app.services.sharing import build_share_url, compute_default_expiry, generate_share_id
from app.services.storage import (
    build_storage_path,
    create_signed_upload,
    ensure_bucket_has_no_size_limit,
    get_capture_row,
    get_supabase_client,
    get_uploaded_object_size,
    insert_capture_row,
    update_capture_row,
    upload_file_bytes,
)

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

    # Read in chunks and check the running total against the limit as we
    # go, instead of reading the entire body first and rejecting only
    # afterward -- for an oversized file, this aborts as soon as the
    # limit is crossed rather than fully buffering something that was
    # always going to be rejected. It does not change the memory profile
    # of a file that's within the limit (that's inherent to this upload
    # path -- see the comment on Settings.max_file_size_bytes for why,
    # and why R2 is the better destination for very large recordings).
    chunk_size = 4 * 1024 * 1024  # 4MB
    chunks: list[bytes] = []
    total_size = 0
    size_limit = settings.max_file_size_bytes  # None = no cap
    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        total_size += len(chunk)
        if size_limit is not None and total_size > size_limit:
            raise HTTPException(
                status_code=413,
                detail=f"File exceeds the {settings.MAX_FILE_SIZE_MB}MB upload limit.",
            )
        chunks.append(chunk)
    data = b"".join(chunks)
    size_bytes = len(data)

    if size_bytes == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

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
                "expires_at": compute_default_expiry(),
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


@router.get("/api/diagnostics/supabase")
async def diagnose_supabase_setup():
    """Self-service setup checker: verifies each piece of the Supabase
    configuration independently and reports exactly what's working and
    what isn't. Meant to be visited directly in a browser (it's a GET
    endpoint, no auth/body needed) when uploads or share links aren't
    working and it isn't obvious why -- rather than guessing across
    several failed real upload attempts, this checks credentials, the
    bucket, and the database table each in isolation and says precisely
    which one (if any) is the problem, with the exact underlying error
    message if one occurred, not just an error CODE."""
    result: dict = {"supabase_configured": settings.supabase_configured}

    if not settings.supabase_configured:
        result["problem"] = (
            "SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set in this "
            "backend's deployed environment. Check your hosting platform's "
            "environment variable settings, not just your local .env file — "
            "a local .env file has no effect on what's actually deployed."
        )
        return result

    client = get_supabase_client()

    # Check 1: does the configured bucket actually exist?
    result["configured_bucket_name"] = settings.SUPABASE_BUCKET
    try:
        buckets = client.storage.list_buckets()
        bucket_names = [b.name for b in buckets]
        result["buckets_found_in_project"] = bucket_names
        matching_bucket = next((b for b in buckets if b.name == settings.SUPABASE_BUCKET), None)
        if matching_bucket:
            result["bucket_exists"] = True
            result["bucket_is_public"] = matching_bucket.public
            result["bucket_file_size_limit_bytes"] = matching_bucket.file_size_limit

            # Uses the same self-heal logic create_upload_signed_url()
            # runs on every real upload attempt now (see
            # ensure_bucket_has_no_size_limit's docstring) -- this
            # diagnostic endpoint reports what that check finds/fixes in
            # full detail, including a failure to fix it, rather than
            # duplicating the fix logic itself.
            try:
                fix_message = ensure_bucket_has_no_size_limit(settings.SUPABASE_BUCKET)
                if fix_message:
                    result["bucket_file_size_limit_fix"] = (
                        f"{fix_message} This was almost certainly why larger uploads were failing "
                        f"with 'Upload to storage failed (400)' while smaller ones succeeded. "
                        f"Try uploading again."
                    )
            except Exception as exc:  # noqa: BLE001
                result["bucket_file_size_limit_fix"] = (
                    f"Found a bucket-level file size limit of {matching_bucket.file_size_limit} bytes "
                    f"but could not remove it automatically: {exc}. Fix it manually in the Supabase "
                    f"dashboard: Storage -> click the bucket -> settings (gear icon) -> File size limit."
                )
        else:
            result["bucket_exists"] = False
            result["bucket_problem"] = (
                f"No bucket named '{settings.SUPABASE_BUCKET}' exists in this Supabase project. "
                f"Buckets that DO exist: {bucket_names or '(none at all)'}. "
                f"Go to Storage in your Supabase dashboard and create a bucket named exactly "
                f"'{settings.SUPABASE_BUCKET}' (or change SUPABASE_BUCKET in your backend's "
                f"environment variables to match an existing bucket's name)."
            )
    except Exception as exc:  # noqa: BLE001 — surfaced directly, this endpoint exists to show the real error
        result["bucket_exists"] = None
        result["bucket_check_error"] = (
            f"Could not list storage buckets at all: {exc}. This usually means "
            f"SUPABASE_SERVICE_ROLE_KEY is wrong, expired, or is the 'anon' key "
            f"instead of the 'service_role' key."
        )

    # Check 2: does the captures table exist and is it reachable?
    try:
        client.table("captures").select("share_id").limit(1).execute()
        result["captures_table_exists"] = True
    except Exception as exc:  # noqa: BLE001
        result["captures_table_exists"] = False
        result["captures_table_error"] = (
            f"{exc}. Run the current supabase/schema.sql in your Supabase project's "
            f"SQL Editor — it's safe to re-run even if you think you already have."
        )

    # Check 3: end-to-end — can we actually generate a signed upload URL?
    # This is the single most direct test, since it's the exact operation
    # that fails when a real share-link creation fails.
    if result.get("bucket_exists"):
        try:
            test_path = f"_diagnostics/{secrets.token_hex(8)}.txt"
            signed = create_signed_upload(test_path)
            result["signed_upload_url_generation"] = "OK — a real signed upload URL was generated successfully."
        except Exception as exc:  # noqa: BLE001
            result["signed_upload_url_generation"] = f"FAILED: {exc}"
    else:
        result["signed_upload_url_generation"] = "SKIPPED (bucket doesn't exist — fix that first)"

    result["overall"] = (
        "Everything checks out — if uploads still fail after this, the issue is likely "
        "somewhere else (CORS, the extension's configured backend URL, or a network/proxy issue)."
        if result.get("bucket_exists") and result.get("captures_table_exists")
        and result.get("signed_upload_url_generation", "").startswith("OK")
        else "At least one check above failed — that's very likely your root cause."
    )
    return result


@router.post("/api/upload/signed-url", response_model=SignedUploadUrlResponse)
async def create_upload_signed_url(payload: SignedUploadUrlRequest):
    """First step of the direct-to-Supabase upload flow: this backend
    generates a signed, single-object upload URL (using its own
    privileged credentials, server-side only) and hands it to the
    browser, along with a pending capture row to fill in once the
    browser's own direct PUT to Supabase Storage completes. The file
    bytes themselves never pass through this endpoint or this server's
    memory at all -- see create_signed_upload()'s docstring for why this
    is what actually removes the "no limit" bottleneck, not just works
    around it."""
    if payload.media_type not in ("screenshot", "recording"):
        raise HTTPException(status_code=400, detail="media_type must be 'screenshot' or 'recording'.")
    if _base_mime_type(payload.content_type) not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported MIME type: {payload.content_type}")
    _validate_filename(payload.file_name)

    if not settings.supabase_configured:
        raise HTTPException(
            status_code=503,
            detail="Cloud sharing is not configured on this server yet. "
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the backend .env file.",
        )

    # Best-effort self-heal: if the bucket has a restrictive size limit
    # set (a real, common cause of large uploads failing with "Upload to
    # storage failed (400)" while small ones succeed — see
    # ensure_bucket_has_no_size_limit's docstring), remove it before even
    # generating this signed URL, rather than requiring a separate visit
    # to the diagnostic endpoint first. Deliberately non-blocking: a
    # failure here should never be the reason a real upload request fails
    # outright, so any exception is swallowed at this call site.
    try:
        ensure_bucket_has_no_size_limit(settings.SUPABASE_BUCKET)
    except Exception:  # noqa: BLE001 — see comment above
        pass

    share_id = generate_share_id()
    now = datetime.now(timezone.utc)
    storage_path = build_storage_path(share_id, payload.file_name, now)

    try:
        signed = create_signed_upload(storage_path)
    except Exception as exc:  # noqa: BLE001 — surfaced as a clean 502 to the client
        raise HTTPException(status_code=502, detail=f"Could not prepare the upload: {exc}") from exc

    insert_capture_row(
        {
            "share_id": share_id,
            "type": payload.media_type,
            "original_filename": payload.file_name,
            "storage_path": storage_path,
            "mime_type": payload.content_type,
            "size_bytes": 0,  # unknown until /api/upload/complete verifies it
            "duration_seconds": 0,
            "created_at": now.isoformat(),
            "expires_at": compute_default_expiry(),
            "storage_provider": "supabase",
            "status": "pending",
            "client_id": payload.client_id,
        }
    )

    return SignedUploadUrlResponse(
        success=True,
        id=share_id,
        signed_url=signed["signed_url"],
        token=signed["token"],
        storage_path=storage_path,
    )


@router.post("/api/upload/complete")
async def complete_signed_upload(payload: CompleteSignedUploadRequest):
    """Second step: called after the browser's own direct PUT to the
    signed URL from /api/upload/signed-url finishes. Verifies the object
    actually exists in Supabase Storage and reads its real, server-
    recorded size (not a client-reported number) before marking the row
    complete and handing back the share link — mirrors R2's
    head_object-based verification for the same reason: this backend
    never directly received the bytes, so it shouldn't just trust
    whatever the client claims about them."""
    row = get_capture_row(payload.id)
    if not row:
        raise HTTPException(status_code=404, detail="Upload not found. Did you call /api/upload/signed-url first?")
    if row.get("storage_provider") != "supabase":
        raise HTTPException(status_code=400, detail="This upload ID was not created via the signed-upload flow.")

    actual_size = get_uploaded_object_size(row["storage_path"])
    if actual_size is None:
        raise HTTPException(
            status_code=400,
            detail="The file doesn't appear to have finished uploading yet — its upload to storage may have failed or is still in progress.",
        )

    update_capture_row(
        payload.id,
        {"status": "complete", "size_bytes": actual_size, "duration_seconds": payload.duration_seconds},
    )

    base = get_settings().effective_public_base_url
    return {
        "success": True,
        "id": payload.id,
        "share_url": build_share_url(payload.id),
        "file_url": f"{base}/s/{payload.id}",
    }
