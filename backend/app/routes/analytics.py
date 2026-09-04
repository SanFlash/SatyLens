"""
app/routes/analytics.py
Analytics ingestion (POST) and reporting (GET) endpoints.

Ingestion endpoints (/api/session/start, /api/session/end, /api/events)
are intentionally left open, matching "there is no authorization/access-
blocking requirement" for the extension's own telemetry -- the extension
must never be blocked from working because analytics is unreachable or
unauthenticated.

Reporting endpoints (/api/analytics/*) are a different story: they return
aggregated data about every installation, which is exactly the kind of
thing that shouldn't sit wide open on the public internet. They're gated
by an optional shared token (ANALYTICS_DASHBOARD_TOKEN in .env) -- if you
leave that unset, the endpoints stay open (matching the letter of "no
auth requirement"), but setting it is strongly recommended for anything
beyond local development. This is a deliberate, documented deviation
toward safer defaults, not a silent one.
"""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query, Request

from app.config import get_settings
from app.models.analytics import (
    EventBatchRequest,
    SessionEndRequest,
    SessionStartRequest,
)
from app.services import analytics as analytics_service

router = APIRouter()
settings = get_settings()


def _require_dashboard_access(x_analytics_token: str | None) -> None:
    token = getattr(settings, "ANALYTICS_DASHBOARD_TOKEN", "")
    if not token:
        return  # no token configured -> reporting endpoints are open
    if x_analytics_token != token:
        raise HTTPException(status_code=401, detail="Missing or invalid analytics dashboard token.")


def _require_supabase() -> None:
    if not settings.supabase_configured:
        raise HTTPException(
            status_code=503,
            detail="Analytics storage is not configured on this server yet. "
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the backend .env file.",
        )


# ============================== Ingestion ==============================

@router.post("/api/session/start")
async def session_start(payload: SessionStartRequest, request: Request):
    _require_supabase()
    country = analytics_service.resolve_country(request.headers)
    analytics_service.start_session(payload.session_id, payload.model_dump(), country)
    return {"success": True}


@router.post("/api/session/end")
async def session_end(payload: SessionEndRequest):
    _require_supabase()
    found = analytics_service.end_session(payload.session_id)
    return {"success": True, "found": found}


@router.post("/api/events")
async def ingest_events(payload: EventBatchRequest, request: Request):
    _require_supabase()
    country = analytics_service.resolve_country(request.headers)
    events = [e.model_dump() for e in payload.events]
    count = analytics_service.insert_events(events, country)
    return {"success": True, "ingested": count}


# ============================== Reporting ==============================

@router.get("/api/analytics/overview")
async def overview(days: int = Query(30, ge=1, le=365), x_analytics_token: str | None = Header(default=None)):
    _require_dashboard_access(x_analytics_token)
    _require_supabase()
    return analytics_service.get_overview(days)


@router.get("/api/analytics/users")
async def users(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    x_analytics_token: str | None = Header(default=None),
):
    _require_dashboard_access(x_analytics_token)
    _require_supabase()
    return analytics_service.list_users(limit, offset)


@router.get("/api/analytics/user/{client_id}")
async def user_detail(client_id: str, x_analytics_token: str | None = Header(default=None)):
    _require_dashboard_access(x_analytics_token)
    _require_supabase()
    detail = analytics_service.get_user_detail(client_id)
    if not detail:
        raise HTTPException(status_code=404, detail="No installation found for this client_id.")
    return detail


@router.get("/api/analytics/features")
async def features(days: int = Query(30, ge=1, le=365), x_analytics_token: str | None = Header(default=None)):
    _require_dashboard_access(x_analytics_token)
    _require_supabase()
    return analytics_service.get_features_breakdown(days)


@router.get("/api/analytics/activity")
async def activity(limit: int = Query(50, ge=1, le=200), x_analytics_token: str | None = Header(default=None)):
    _require_dashboard_access(x_analytics_token)
    _require_supabase()
    return analytics_service.get_recent_activity(limit)


@router.get("/api/analytics/timeseries")
async def timeseries(
    metric: str = Query(..., pattern="^(dau|screenshots|recordings|uploads|errors)$"),
    days: int = Query(30, ge=1, le=180),
    x_analytics_token: str | None = Header(default=None),
):
    _require_dashboard_access(x_analytics_token)
    _require_supabase()
    return analytics_service.get_timeseries(metric, days)
