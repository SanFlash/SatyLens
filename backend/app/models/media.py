"""
app/models/media.py
Pydantic schemas for the R2 direct-upload flow (POST /api/media/upload-url
-> direct browser PUT to R2 -> POST /api/media/complete) and the share/
link-management endpoints built on top of it.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

MediaType = Literal["screenshot", "recording", "collage"]


class UploadUrlRequest(BaseModel):
    file_name: str = Field(..., min_length=1, max_length=255)
    content_type: str
    file_size: int = Field(..., gt=0)
    media_type: MediaType
    # Not in the original spec's payload, but there's no user-auth system
    # in this project to scope "whose upload is this" — reusing the same
    # anonymous client_id the analytics system already generates client-
    # side (extension/shared/analytics.js) gives /api/media/history a
    # sensible per-installation scope without inventing a parallel
    # identity system. Optional: omitted, history/ownership scoping for
    # that upload is simply skipped.
    client_id: Optional[str] = Field(default=None, min_length=8, max_length=128)


class UploadUrlResponse(BaseModel):
    success: bool
    upload_url: str
    object_key: str
    upload_id: str
    expires_in: int


class CompleteUploadRequest(BaseModel):
    upload_id: str
    object_key: str
    media_type: MediaType
    file_name: str
    content_type: str
    file_size: int = Field(..., gt=0)


class CompleteUploadResponse(BaseModel):
    success: bool
    id: str
    share_url: str


class MediaHistoryItem(BaseModel):
    id: str
    media_type: str
    file_name: str
    size_bytes: int
    created_at: datetime
    expires_at: Optional[datetime]
    revoked: bool
    view_count: int
    download_count: int
    share_url: str


class MediaDetailResponse(MediaHistoryItem):
    content_type: str
    storage_provider: str


class ExpireRequest(BaseModel):
    hours: Optional[int] = Field(default=None, ge=1, le=8760)  # None = never expires
