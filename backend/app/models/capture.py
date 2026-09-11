"""
app/models/capture.py
Pydantic schemas for capture metadata as stored in Supabase Postgres
(table: captures) and returned by the API.
"""
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel


CaptureType = Literal["screenshot", "recording", "collage"]


class CaptureRecord(BaseModel):
    id: str
    share_id: str
    type: CaptureType
    original_filename: str
    storage_path: str
    mime_type: str
    size_bytes: int
    duration_seconds: float = 0
    created_at: datetime
    expires_at: Optional[datetime] = None


class UploadResponse(BaseModel):
    success: bool
    id: str
    share_url: str
    file_url: str


class ShareInfoResponse(BaseModel):
    id: str
    type: CaptureType
    original_filename: str
    mime_type: str
    size_bytes: int
    duration_seconds: float
    created_at: datetime
    file_url: str


class SetSharePasswordRequest(BaseModel):
    # None/empty clears password protection; any non-empty string sets/replaces it.
    password: Optional[str] = None


class SignedUploadUrlRequest(BaseModel):
    file_name: str
    content_type: str
    media_type: CaptureType
    client_id: Optional[str] = None


class SignedUploadUrlResponse(BaseModel):
    success: bool
    id: str
    signed_url: str
    token: str
    storage_path: str


class CompleteSignedUploadRequest(BaseModel):
    id: str
    duration_seconds: float = 0
