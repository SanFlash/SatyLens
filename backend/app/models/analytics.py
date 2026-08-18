"""
app/models/analytics.py
Pydantic schemas for the analytics/telemetry system.

Privacy note: `client_id` is a random UUID generated and stored locally by
the extension (see extension/shared/analytics.js) — it is not a Google
account ID, email, or any other real-world identifier. Nothing here
accepts or stores page URLs, page content, keystrokes, or precise
coordinates. Coarse location (a country code) is derived server-side, if
available, from infrastructure headers at request time — raw IP addresses
are never persisted (see app/services/analytics.py).
"""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


class ClientContext(BaseModel):
    client_id: str = Field(..., min_length=8, max_length=128)
    extension_version: str = "0.0.0"
    browser: str = "unknown"
    browser_version: str = "0"
    os: str = "unknown"
    device_type: str = "desktop"


class SessionStartRequest(ClientContext):
    session_id: str = Field(..., min_length=8, max_length=128)


class SessionEndRequest(BaseModel):
    session_id: str


class EventIn(ClientContext):
    session_id: str
    event_type: str = Field(..., min_length=1, max_length=64)
    feature: Optional[str] = None
    action: Optional[str] = None
    success: bool = True
    error_message: Optional[str] = Field(default=None, max_length=500)
    duration_ms: Optional[int] = Field(default=None, ge=0, le=3_600_000)
    timestamp: Optional[datetime] = None


class EventBatchRequest(BaseModel):
    events: List[EventIn] = Field(..., min_length=1, max_length=100)


class TimeseriesPoint(BaseModel):
    date: str
    count: int


class OverviewResponse(BaseModel):
    total_users: int
    active_users: dict  # {"daily": int, "weekly": int, "monthly": int}
    total_sessions: int
    screenshots_captured: int
    screen_recordings: int
    uploads: int
    links_generated: int
    collages_created: int
    most_used_features: List[dict]  # [{"feature": str, "count": int}]
    failed_operations: int
    extension_versions: List[dict]  # [{"version": str, "count": int}]


class UserSummary(BaseModel):
    client_id: str
    first_seen: Optional[datetime]
    last_seen: Optional[datetime]
    total_sessions: int
    total_actions: int
    extension_version: Optional[str]
    browser: Optional[str]
    os: Optional[str]


class UserDetailResponse(BaseModel):
    client_id: str
    first_seen: Optional[datetime]
    last_seen: Optional[datetime]
    total_sessions: int
    total_actions: int
    screenshots: int
    screen_recordings: int
    uploads: int
    links_generated: int
    activity_timeline: List[dict]


class ActivityItem(BaseModel):
    client_id: str
    event_type: str
    feature: Optional[str]
    action: Optional[str]
    success: bool
    created_at: datetime
